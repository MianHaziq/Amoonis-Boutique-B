const prisma = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const { verifyAppleToken } = require('../services/appleAuth.service');
const { success, error } = require('../utils/response');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
    firstName: user.firstName,
    lastName: user.lastName,
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
    const { firstName, lastName, email, password } = req.body;

    if (!firstName || !lastName || !email || !password) {
      return error(res, 'First name, last name, email, and password are required', 400);
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return error(res, 'Email already registered', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        password: hashedPassword,
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, status: true, createdAt: true },
    });

    const token = generateToken(user.id, user.role);
    return success(res, { user, token }, 'User registered successfully', 201);
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

    let googleId, email, given_name, family_name, picture;

    if (idToken) {
      // Flow 1: ID token verification (from Google One Tap / GoogleLogin component)
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        googleId = payload.sub;
        email = payload.email;
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

    const firstName = given_name || '';
    const lastName = family_name || '';
    let user = null;
    let isNewUser = false;

    // 1. Try finding by googleId first (returning user)
    user = await prisma.user.findUnique({ where: { googleId } });

    if (user) {
      // Update name and avatar from Google on every login
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          firstName: firstName || user.firstName,
          lastName: lastName || user.lastName,
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
        // 3. Brand new user
        user = await prisma.user.create({
          data: {
            googleId,
            email,
            firstName,
            lastName,
            avatar: picture || null,
            isEmailVerified: true,
          },
        });
        isNewUser = true;
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
    const { firstName: bodyFirstName, lastName: bodyLastName, email: bodyEmail } = req.body;

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
    const firstName = (bodyFirstName || '').trim() || null;
    const lastName = (bodyLastName || '').trim() || null;

    let user = await prisma.user.findUnique({ where: { appleId } });
    let isNewUser = false;

    if (user) {
      const updateData = {};
      if (firstName) updateData.firstName = firstName;
      if (lastName) updateData.lastName = lastName;
      if (Object.keys(updateData).length > 0) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: updateData,
        });
      }
    } else {
      user = await prisma.user.findUnique({ where: { email } });
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
        user = await prisma.user.create({
          data: {
            appleId,
            email,
            firstName: firstName || 'Apple',
            lastName: lastName || 'User',
            isEmailVerified: !!emailFromToken,
          },
        });
        isNewUser = true;
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
        firstName: user.firstName,
        lastName: user.lastName,
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
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    await prisma.user.update({
      where: { email },
      data: { resetToken, resetTokenExpiry },
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

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
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
        firstName: true,
        lastName: true,
        avatar: true,
        role: true,
        status: true,
        isEmailVerified: true,
        managerTitle: true,
        managerPermissions: true,
        preferredLanguage: true,
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
    const { firstName, lastName, email } = req.body;

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
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
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
  updateAddress,
  deleteAccount,
};
