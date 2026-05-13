const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const { verifyAppleToken } = require('../services/appleAuth.service');
const refreshTokenService = require('../services/refreshToken.service');
const { invalidateCachedUser } = require('../middleware/auth');
const { success, error } = require('../utils/response');

function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

const googleClient = new OAuth2Client();
const GOOGLE_AUDIENCE = (process.env.GOOGLE_CLIENT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Helper: Generate JWT token
// `tokenVersion` is included as `tv` so a server-side bump (logout-all / password
// change / admin kick) instantly invalidates already-issued tokens. Callers that
// don't pass it fall back to 0, matching the User default.
const generateToken = (userId, role, tokenVersion = 0) => {
  return jwt.sign(
    { id: userId, role, tv: tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Issues an access token plus a refresh token for the given user row. The
// refresh token is the only field added to the response — mobile clients that
// have not yet adopted it can keep ignoring the new key safely.
async function issueAuthTokens(user, req) {
  const accessToken = generateToken(user.id, user.role, user.tokenVersion ?? 0);
  let refreshToken = null;
  let refreshTokenExpiresAt = null;
  try {
    const issued = await refreshTokenService.issueRefreshToken(
      user.id,
      req?.headers?.['user-agent'] || null
    );
    refreshToken = issued.token;
    refreshTokenExpiresAt = issued.expiresAt;
  } catch (err) {
    // Refresh-token persistence failure must NOT block sign-in for the mobile
    // app. Log and proceed with the access token only — the app keeps working
    // exactly like before.
    console.error('[auth] issueRefreshToken failed:', err.message);
  }
  return { accessToken, refreshToken, refreshTokenExpiresAt };
}

function authSessionUserFields(user) {
  const base = {
    id: user.id,
    email: user.email,
    fullName: user.fullName || null,
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
      select: { id: true, email: true, fullName: true, role: true, status: true, tokenVersion: true, createdAt: true },
    });

    const { accessToken, refreshToken, refreshTokenExpiresAt } = await issueAuthTokens(created, req);
    const responseData = {
      user: {
        id: created.id,
        email: created.email,
        fullName: created.fullName || null,
        role: created.role,
        status: created.status,
        createdAt: created.createdAt,
      },
      token: accessToken,
    };
    if (refreshToken) {
      responseData.refreshToken = refreshToken;
      responseData.refreshTokenExpiresAt = refreshTokenExpiresAt;
    }
    return success(res, responseData, 'User registered successfully', 201);
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

    const { accessToken, refreshToken, refreshTokenExpiresAt } = await issueAuthTokens(user, req);
    const responseData = {
      user: authSessionUserFields(user),
      token: accessToken,
    };
    if (refreshToken) {
      responseData.refreshToken = refreshToken;
      responseData.refreshTokenExpiresAt = refreshTokenExpiresAt;
    }
    return success(res, responseData, 'Login successful', 200);
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

    // Renamed locals here only — the request body already destructured a Google
    // `accessToken` (the OAuth bearer the client passed us). We need a different
    // name for our own session access token to avoid shadowing it.
    const tokens = await issueAuthTokens(user, req);
    const responseData = {
      user: authSessionUserFields(user),
      token: tokens.accessToken,
      isNewUser,
    };
    if (tokens.refreshToken) {
      responseData.refreshToken = tokens.refreshToken;
      responseData.refreshTokenExpiresAt = tokens.refreshTokenExpiresAt;
    }
    return success(
      res,
      responseData,
      isNewUser ? 'Account created successfully' : 'Google login successful',
      200
    );
  } catch (err) {
    next(err);
  }
};

// Apple Login
const appleLogin = async (req, res, next) => {
  try {
    const identityToken = req.body.identityToken || req.body.id_token;
    const { fullName: bodyFullName, email: bodyEmail } = req.body;

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
    const fullName = (bodyFullName && bodyFullName.trim()) || null;

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
      // SECURITY: only the email Apple itself signed (`payload.email`) is trusted
      // for linking to an existing account. `bodyEmail` is supplied by the
      // client and could be any address; if we used it for lookup, an attacker
      // could pass a victim's email and have their own Apple `sub` linked to
      // the victim's account on the spot. Apple always includes the email on
      // the *first* Sign in with Apple for a given app, which is the only
      // situation where a brand-new appleId needs to be linked, so this branch
      // covers all legitimate first-time sign-ins.
      user = emailFromToken
        ? await prisma.user.findUnique({ where: { email: emailFromToken } })
        : null;

      if (user) {
        if (user.appleId && user.appleId !== appleId) {
          // Another Apple identity is already linked to this email. Refuse to
          // silently re-link — that path is account takeover.
          return error(
            res,
            'This email is already linked to a different Apple ID. Please sign in with your original method.',
            409
          );
        }
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            appleId,
            isEmailVerified: user.isEmailVerified || !!emailFromToken,
          },
        });
      } else {
        // No existing user. Create a fresh account.
        //   - Prefer the email Apple signed (verified).
        //   - Fall back to bodyEmail only when *no* user exists with that
        //     email — that means no account is being taken over.
        //   - Mark email verified only when it came from Apple.
        const createEmail = emailFromToken || (bodyEmail ? String(bodyEmail).trim().toLowerCase() : null);
        if (!createEmail) {
          return error(
            res,
            'Email is required to create an account. Please share your email with Sign in with Apple.',
            400
          );
        }

        if (!emailFromToken && bodyEmail) {
          // Defence-in-depth: even with `bodyEmail`, if a user already has it,
          // refuse to attach this Apple identity — we cannot prove the caller
          // owns that mailbox.
          const collision = await prisma.user.findUnique({ where: { email: createEmail } });
          if (collision) {
            return error(
              res,
              'An account with this email already exists. Please sign in with your original method, then link Apple from settings.',
              409
            );
          }
        }

        try {
          user = await prisma.user.upsert({
            where: { appleId },
            update: { fullName: fullName || undefined },
            create: {
              appleId,
              email: createEmail,
              fullName: fullName || null,
              isEmailVerified: !!emailFromToken,
            },
          });
          isNewUser = !user.updatedAt || user.createdAt.getTime() === user.updatedAt.getTime();
        } catch (raceErr) {
          if (raceErr.code === 'P2002') {
            // Another request linked this Apple ID concurrently. Re-read by
            // appleId and proceed (do NOT silently link by email).
            const recheck = await prisma.user.findUnique({ where: { appleId } });
            if (recheck) {
              user = recheck;
            } else {
              throw raceErr;
            }
          } else {
            throw raceErr;
          }
        }
      }
    }

    if (user.status === 'INACTIVE') {
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    const { accessToken, refreshToken, refreshTokenExpiresAt } = await issueAuthTokens(user, req);
    const responseData = {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName || null,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        isEmailVerified: user.isEmailVerified,
      },
      token: accessToken,
      isNewUser,
    };
    if (refreshToken) {
      responseData.refreshToken = refreshToken;
      responseData.refreshTokenExpiresAt = refreshTokenExpiresAt;
    }
    return success(
      res,
      responseData,
      isNewUser ? 'Account created successfully' : 'Apple login successful',
      200
    );
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
    // Bumping tokenVersion invalidates every access token currently in
    // circulation for this user (other devices / sessions). Combined with the
    // refresh-token revocation below this gives a real "sign me out
    // everywhere" guarantee on the password-change event.
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
    });
    try {
      await refreshTokenService.revokeAllForUser(userId);
    } catch (revErr) {
      console.error('[auth] revokeAllForUser after password change failed:', revErr.message);
    }
    invalidateCachedUser(userId);

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
        // Invalidate all in-flight access tokens for this user — the password
        // changed, so prior sessions on other devices should not survive.
        tokenVersion: { increment: 1 },
      },
    });
    try {
      await refreshTokenService.revokeAllForUser(user.id);
    } catch (revErr) {
      console.error('[auth] revokeAllForUser after password reset failed:', revErr.message);
    }
    invalidateCachedUser(user.id);

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

    return success(res, user, 'Profile fetched successfully', 200);
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
        role: true,
        status: true,
        avatar: true,
        isEmailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return success(res, user, 'Profile updated successfully', 200);
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

// Refresh — exchange a refresh token for a new access token (and rotate the
// refresh token). Returns the same shape mobile clients already parse for tokens,
// with the same key names (`token` + `refreshToken`) so adoption is incremental.
const refreshAccessToken = async (req, res, next) => {
  try {
    const provided = req.body?.refreshToken;
    if (!provided || typeof provided !== 'string') {
      return error(res, 'refreshToken is required', 400);
    }

    const rotated = await refreshTokenService.rotateRefreshToken(
      provided,
      req?.headers?.['user-agent'] || null
    );
    if (!rotated) {
      return error(res, 'Invalid or expired refresh token. Please login again.', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: rotated.userId },
      select: { id: true, role: true, status: true, tokenVersion: true },
    });
    if (!user) {
      // The user was deleted between issuing the refresh token and now —
      // revoke this token defensively and reject.
      await refreshTokenService.revokeAllForUser(rotated.userId).catch(() => {});
      return error(res, 'Invalid or expired refresh token. Please login again.', 401);
    }
    if (user.status !== 'ACTIVE') {
      await refreshTokenService.revokeAllForUser(user.id).catch(() => {});
      return error(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    const accessToken = generateToken(user.id, user.role, user.tokenVersion ?? 0);
    return success(
      res,
      {
        token: accessToken,
        refreshToken: rotated.token,
        refreshTokenExpiresAt: rotated.expiresAt,
      },
      'Token refreshed successfully',
      200
    );
  } catch (err) {
    next(err);
  }
};

// Logout — revokes the refresh token only. Access tokens stay valid until they
// expire on their own (typical mobile pattern). For a hard "kick", use change
// password or admin status toggle, both of which bump tokenVersion.
const logout = async (req, res, next) => {
  try {
    const provided = req.body?.refreshToken;
    if (provided) {
      await refreshTokenService.revokeRawToken(provided);
    } else if (req.userId) {
      // Fallback: token-authenticated logout with no body — revoke every
      // refresh token for the current user.
      await refreshTokenService.revokeAllForUser(req.userId);
    }
    return success(res, null, 'Logged out successfully', 200);
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
  refreshAccessToken,
  logout,
  getMe,
  getProfile,
  updateProfile,
  updatePreferredLanguage,
  updatePhone,
  updateAddress,
  deleteAccount,
};
