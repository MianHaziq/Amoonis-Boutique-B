const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const { verifyAppleToken } = require('../services/appleAuth.service');
const { success, error } = require('../utils/response');

function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

// Derive a back-compat first/last from the canonical fullName so existing
// clients keep receiving these fields during the rollout. First whitespace-
// separated token is the first name, the remainder is the last name.
function splitFullName(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const parts = trimmed.split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

// Build the name fields for an API response: prefer the canonical fullName,
// fall back to legacy firstName/lastName for users created before the migration.
function nameFieldsForResponse(user) {
  const fullName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null;
  const split = user.fullName
    ? splitFullName(user.fullName)
    : { firstName: user.firstName ?? null, lastName: user.lastName ?? null };
  return { fullName, firstName: split.firstName, lastName: split.lastName };
}

const googleClient = new OAuth2Client();
const GOOGLE_AUDIENCE = (process.env.GOOGLE_CLIENT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Helper: Generate JWT token
const generateToken = (userId, role) => {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

function authSessionUserFields(user) {
  const base = {
    id: user.id,
    email: user.email,
    ...nameFieldsForResponse(user),
    role: user.role,
    status: user.status,
    managerTitle: user.role === 'MANAGER' ? user.managerTitle || null : null,
    managerPermissions: user.role === 'MANAGER' ? user.managerPermissions || [] : [],
  };
  if (user.avatar != null) base.avatar = user.avatar;
  if (user.isEmailVerified != null) base.isEmailVerified = user.isEmailVerified;
  return base;
}

// Helper: Send email
const sendEmail = async (to, subject, html) => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.FROM_EMAIL,
    to,
    subject,
    html,
  });
};

// Signup
const signup = async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body;
    const trimmedFullName = (fullName || '').trim();

    if (!trimmedFullName || !email || !password) {
      return error(res, 'Full name, email, and password are required', 400);
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return error(res, 'Email already registered', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const created = await prisma.user.create({
      data: {
        fullName: trimmedFullName,
        email,
        password: hashedPassword,
      },
      select: { id: true, email: true, fullName: true, firstName: true, lastName: true, role: true, status: true, createdAt: true },
    });

    const token = generateToken(created.id, created.role);
    return success(
      res,
      {
        user: {
          id: created.id,
          email: created.email,
          ...nameFieldsForResponse(created),
          role: created.role,
          status: created.status,
          createdAt: created.createdAt,
        },
        token,
      },
      'User registered successfully',
      201
    );
  } catch (err) {
    next(err);
  }
};

// Signin
const signin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return error(res, 'Email and password are required', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      return error(res, 'Invalid email or password', 401);
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return error(res, 'Invalid email or password', 401);
    }

    if (user.status === 'INACTIVE') {
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    const token = generateToken(user.id, user.role);
    return success(res, {
      user: authSessionUserFields(user),
      token,
    }, 'Login successful', 200);
  } catch (err) {
    next(err);
  }
};

// Google Login
const googleLogin = async (req, res, next) => {
  try {
    const idToken = req.body.idToken || req.body.credential;
    const { accessToken } = req.body;

    if (!idToken && !accessToken) {
      return error(res, 'Google token is required', 400);
    }

    let googleId, email, name, given_name, family_name, picture;

    if (idToken) {
      // Flow 1: ID token verification (from Google One Tap / GoogleLogin component)
      try {
        if (GOOGLE_AUDIENCE.length === 0) {
          return error(res, 'Google Sign In is not configured', 503);
        }
        const ticket = await googleClient.verifyIdToken({
          idToken,
          audience: GOOGLE_AUDIENCE,
        });
        const payload = ticket.getPayload();
        googleId = payload.sub;
        email = payload.email;
        name = payload.name;
        given_name = payload.given_name;
        family_name = payload.family_name;
        picture = payload.picture;
      } catch (verifyError) {
        return error(res, 'Invalid or expired Google token', 401);
      }
    } else {
      // Flow 2: Access token verification (from useGoogleLogin custom button)
      try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          return error(res, 'Invalid or expired Google access token', 401);
        }
        const userInfo = await response.json();
        googleId = userInfo.sub;
        email = userInfo.email;
        name = userInfo.name;
        given_name = userInfo.given_name;
        family_name = userInfo.family_name;
        picture = userInfo.picture;
      } catch (fetchError) {
        return error(res, 'Failed to verify Google access token', 401);
      }
    }

    if (!email) {
      return error(res, 'Google account does not have an email address', 400);
    }

    const fullName = (name && name.trim())
      || [given_name, family_name].filter(Boolean).join(' ').trim()
      || null;
    let user = null;
    let isNewUser = false;

    // 1. Try finding by googleId first (returning user)
    user = await prisma.user.findUnique({ where: { googleId } });

    if (user) {
      // Update name and avatar from Google on every login
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          fullName: fullName || user.fullName,
          avatar: picture || user.avatar,
        },
      });
    } else {
      // 2. Check if email already exists (link Google to existing account)
      user = await prisma.user.findUnique({ where: { email } });

      if (user) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId,
            isEmailVerified: true,
            avatar: picture || user.avatar,
          },
        });
      } else {
        // 3. Brand new user — use upsert on googleId to survive the race where two parallel
        // first-time logins both miss the findUnique above. The unique googleId constraint
        // serializes the second request and we end up with one row, no 500.
        try {
          user = await prisma.user.upsert({
            where: { googleId },
            update: {
              fullName: fullName || undefined,
              avatar: picture || undefined,
            },
            create: {
              googleId,
              email,
              fullName,
              avatar: picture || null,
              isEmailVerified: true,
            },
          });
          // If the row was just created (no prior link), treat as new user for the response.
          isNewUser = !user.updatedAt || user.createdAt.getTime() === user.updatedAt.getTime();
        } catch (raceErr) {
          // Email-conflict race: another request linked Google to an existing email between
          // findUnique and upsert. Re-fetch by email and treat as link.
          if (raceErr.code === 'P2002') {
            user = await prisma.user.findUnique({ where: { email } });
            if (user && !user.googleId) {
              user = await prisma.user.update({
                where: { id: user.id },
                data: { googleId, isEmailVerified: true, avatar: picture || user.avatar },
              });
            }
            if (!user) throw raceErr;
          } else {
            throw raceErr;
          }
        }
      }
    }

    if (user.status === 'INACTIVE') {
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    const token = generateToken(user.id, user.role);
    return success(res, {
      user: authSessionUserFields(user),
      token,
      isNewUser,
    }, isNewUser ? 'Account created successfully' : 'Google login successful', 200);
  } catch (err) {
    next(err);
  }
};

// Apple Login
const appleLogin = async (req, res, next) => {
  try {
    const identityToken = req.body.identityToken || req.body.id_token;
    const { fullName: bodyFullName, firstName: bodyFirstName, lastName: bodyLastName, email: bodyEmail } = req.body;

    if (!identityToken) {
      return error(res, 'Identity token is required', 400);
    }

    const clientId = process.env.APPLE_CLIENT_ID;
    if (!clientId) {
      return error(res, 'Apple Sign In is not configured', 503);
    }

    let payload;
    try {
      payload = await verifyAppleToken(identityToken, clientId);
    } catch (verifyErr) {
      return error(
        res,
        verifyErr.message === 'Invalid Apple identity token' || verifyErr.name === 'JsonWebTokenError'
          ? 'Invalid or expired Apple identity token'
          : 'Failed to verify Apple token',
        401
      );
    }

    const appleId = payload.sub;
    const emailFromToken = payload.email || null;
    const email = emailFromToken || bodyEmail || null;
    const fullName = (bodyFullName && bodyFullName.trim())
      || [bodyFirstName, bodyLastName].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      || null;

    let user = await prisma.user.findUnique({ where: { appleId } });
    let isNewUser = false;

    if (user) {
      if (fullName) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { fullName },
        });
      }
    } else {
      user = email ? await prisma.user.findUnique({ where: { email } }) : null;
      if (user) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            appleId,
            isEmailVerified: user.isEmailVerified || !!emailFromToken,
          },
        });
      } else {
        if (!email) {
          return error(
            res,
            'Email is required to create an account. Please share your email with Sign in with Apple.',
            400
          );
        }
        // Upsert on appleId to absorb the race where two parallel first-time Apple logins
        // both miss the findUnique. Postgres unique constraint serializes them.
        try {
          user = await prisma.user.upsert({
            where: { appleId },
            update: {
              fullName: fullName || undefined,
            },
            create: {
              appleId,
              email,
              fullName: fullName || null,
              isEmailVerified: !!emailFromToken,
            },
          });
          isNewUser = !user.updatedAt || user.createdAt.getTime() === user.updatedAt.getTime();
        } catch (raceErr) {
          // Email already exists with a different unique key — link Apple to that account.
          if (raceErr.code === 'P2002') {
            user = await prisma.user.findUnique({ where: { email } });
            if (user && !user.appleId) {
              user = await prisma.user.update({
                where: { id: user.id },
                data: { appleId, isEmailVerified: user.isEmailVerified || !!emailFromToken },
              });
            }
            if (!user) throw raceErr;
          } else {
            throw raceErr;
          }
        }
      }
    }

    if (user.status === 'INACTIVE') {
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    const token = generateToken(user.id, user.role);

    return success(res, {
      user: {
        id: user.id,
        email: user.email,
        ...nameFieldsForResponse(user),
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        isEmailVerified: user.isEmailVerified,
      },
      token,
      isNewUser,
    }, isNewUser ? 'Account created successfully' : 'Apple login successful', 200);
  } catch (err) {
    next(err);
  }
};

// Change Password
const changePassword = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (req.userId && req.userId !== userId) {
      return error(res, 'Forbidden', 403);
    }
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return error(res, 'Current password and new password are required', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (!user.password) {
      return error(res, 'Cannot change password for Google-only accounts', 400);
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return error(res, 'Current password is incorrect', 401);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return success(res, null, 'Password changed successfully', 200);
  } catch (err) {
    next(err);
  }
};

// Forgot Password
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return error(res, 'Email is required', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return success(res, null, 'If email exists, a reset link will be sent', 200);
    }

    const resetToken = uuidv4();
    const resetTokenHash = hashResetToken(resetToken);
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    // Persist only the SHA-256 hash; the raw token leaves the server only via email.
    await prisma.user.update({
      where: { email },
      data: { resetToken: resetTokenHash, resetTokenExpiry },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    await sendEmail(
      email,
      'Password Reset Request',
      `
        <h2>Password Reset</h2>
        <p>You requested a password reset. Click the link below to reset your password:</p>
        <a href="${resetUrl}">${resetUrl}</a>
        <p>This link expires in 1 hour.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `
    );

    return success(res, null, 'If email exists, a reset link will be sent', 200);
  } catch (err) {
    next(err);
  }
};

// Reset Password
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return error(res, 'Token and new password are required', 400);
    }

    // Compare against the stored SHA-256 hash; raw token never sits in the DB.
    const tokenHash = hashResetToken(token);
    const user = await prisma.user.findFirst({
      where: {
        resetToken: tokenHash,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return error(res, 'Invalid or expired reset token', 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    return success(res, null, 'Password reset successfully', 200);
  } catch (err) {
    next(err);
  }
};

// Get current user profile by token (for GET /user/profile)
const getProfile = async (req, res, next) => {
  try {
    const userId = req.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        firstName: true,
        lastName: true,
        avatar: true,
        role: true,
        status: true,
        isEmailVerified: true,
        managerTitle: true,
        managerPermissions: true,
        preferredLanguage: true,
        phone: true,
        addressCountry: true,
        addressCity: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    return success(
      res,
      { ...user, ...nameFieldsForResponse(user) },
      'Profile fetched successfully',
      200
    );
  } catch (err) {
    next(err);
  }
};

// Update preferred language (current user by token)
const updatePreferredLanguage = async (req, res, next) => {
  try {
    const userId = req.userId;
    const { preferredLanguage } = req.body;

    if (preferredLanguage === undefined || preferredLanguage === null) {
      return error(res, 'preferredLanguage is required', 400);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { preferredLanguage: String(preferredLanguage).trim() || null },
      select: {
        id: true,
        preferredLanguage: true,
        updatedAt: true,
      },
    });

    return success(res, { preferredLanguage: user.preferredLanguage }, 'Preferred language updated successfully', 200);
  } catch (err) {
    next(err);
  }
};

// Update address (country, city) for current user by token
const updateAddress = async (req, res, next) => {
  try {
    const userId = req.userId;
    const { addressCountry, addressCity } = req.body;

    const data = {};
    if (addressCountry !== undefined) data.addressCountry = addressCountry ? String(addressCountry).trim() : null;
    if (addressCity !== undefined) data.addressCity = addressCity ? String(addressCity).trim() : null;

    if (Object.keys(data).length === 0) {
      return error(res, 'At least one of addressCountry or addressCity is required', 400);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        addressCountry: true,
        addressCity: true,
        updatedAt: true,
      },
    });

    return success(res, {
      addressCountry: user.addressCountry,
      addressCity: user.addressCity,
    }, 'Address updated successfully', 200);
  } catch (err) {
    next(err);
  }
};

const updatePhone = async (req, res, next) => {
  try {
    const userId = req.userId;
    const { phone } = req.body;

    if (phone === undefined || phone === null) {
      return error(res, 'phone is required', 400);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { phone: String(phone).trim() || null },
      select: { id: true, phone: true, updatedAt: true },
    });

    return success(res, { phone: user.phone }, 'Phone number updated successfully', 200);
  } catch (err) {
    next(err);
  }
};

// Get Current User (Me) by userId (must match token)
const getMe = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (req.userId && req.userId !== userId) {
      return error(res, 'Forbidden', 403);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        firstName: true,
        lastName: true,
        password: true,
        googleId: true,
        appleId: true,
        role: true,
        status: true,
        avatar: true,
        isEmailVerified: true,
        managerTitle: true,
        managerPermissions: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    const { password, googleId, appleId, ...userData } = user;

    return success(res, {
      ...userData,
      ...nameFieldsForResponse(userData),
      managerTitle: userData.role === 'MANAGER' ? userData.managerTitle : null,
      managerPermissions: userData.role === 'MANAGER' ? userData.managerPermissions || [] : [],
      hasPassword: !!password,
      isGoogleUser: !!googleId,
      isAppleUser: !!appleId,
    }, 'User profile fetched successfully', 200);
  } catch (err) {
    next(err);
  }
};

// Update Profile
const updateProfile = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (req.userId && req.userId !== userId) {
      return error(res, 'Forbidden', 403);
    }
    const { fullName, email } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      return error(res, 'User not found', 404);
    }

    if (email && email !== existingUser.email) {
      const emailExists = await prisma.user.findUnique({
        where: { email },
      });
      if (emailExists) {
        return error(res, 'Email already in use', 409);
      }
    }

    const updateData = {};
    if (fullName !== undefined) {
      const trimmed = String(fullName).trim();
      if (!trimmed) {
        return error(res, 'fullName cannot be empty', 400);
      }
      updateData.fullName = trimmed;
    }
    if (email) updateData.email = email;

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        fullName: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        avatar: true,
        isEmailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return success(
      res,
      { ...user, ...nameFieldsForResponse(user) },
      'Profile updated successfully',
      200
    );
  } catch (err) {
    next(err);
  }
};

// Delete Account
const deleteAccount = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (req.userId && req.userId !== userId) {
      return error(res, 'Forbidden', 403);
    }
    const { password } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return error(res, 'User not found', 404);
    }

    if (user.password && password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return error(res, 'Password is incorrect', 401);
      }
    }

    await prisma.user.delete({ where: { id: userId } });

    return success(res, null, 'Account deleted successfully', 200);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  signup,
  signin,
  googleLogin,
  appleLogin,
  changePassword,
  forgotPassword,
  resetPassword,
  getMe,
  getProfile,
  updateProfile,
  updatePreferredLanguage,
  updatePhone,
  updateAddress,
  deleteAccount,
};
