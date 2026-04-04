const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const {
  signup,
  signin,
  googleLogin,
  appleLogin,
  changePassword,
  forgotPassword,
  resetPassword,
  getMe,
  updateProfile,
  deleteAccount,
} = require('../controllers/auth.controller');
const { handleValidationErrors } = require('../middleware/validate');
const { verifyToken } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication APIs
 */

/**
 * @swagger
 * /auth/signup:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SignupInput'
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/AuthUser'
 *                     token:
 *                       type: string
 *       400:
 *         description: Bad request
 *       409:
 *         description: Email already registered
 */
const signupValidation = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').trim().isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];
router.post('/signup', signupValidation, handleValidationErrors, signup);

/**
 * @swagger
 * /auth/signin:
 *   post:
 *     summary: Login with email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SigninInput'
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/AuthUser'
 *                     token:
 *                       type: string
 *       401:
 *         description: Invalid credentials
 */
const signinValidation = [
  body('email').trim().isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];
router.post('/signin', signinValidation, handleValidationErrors, signin);

/**
 * @swagger
 * /auth/google:
 *   post:
 *     summary: Login with Google
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idToken
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token from client
 *     responses:
 *       200:
 *         description: Google login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/AuthUser'
 *                     token:
 *                       type: string
 *       400:
 *         description: Invalid token
 */
router.post('/google', googleLogin);

/**
 * @swagger
 * /auth/apple:
 *   post:
 *     summary: Login with Apple
 *     description: |
 *       Sign in with Apple. Send the **identityToken** (JWT) from the client after Apple Sign In.
 *       Optionally send **firstName**, **lastName**, **email** in the body (Apple provides name only on first authorization; client should pass them for new accounts).
 *       Server verifies the token with Apple's public keys (JWKS). Returns same shape as Google login.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identityToken]
 *             properties:
 *               identityToken:
 *                 type: string
 *                 description: JWT from Sign in with Apple (identityToken)
 *                 example: "eyJraWQiOi..."
 *               id_token:
 *                 type: string
 *                 description: Alias for identityToken (optional)
 *               firstName:
 *                 type: string
 *                 description: User first name (optional; Apple sends only on first sign-in; pass from client)
 *                 example: "John"
 *               lastName:
 *                 type: string
 *                 description: User last name (optional)
 *                 example: "Doe"
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Fallback email if not in token (optional)
 *           example:
 *             identityToken: "eyJraWQiOi..."
 *             firstName: "John"
 *             lastName: "Doe"
 *     responses:
 *       200:
 *         description: Apple login successful; returns user and JWT
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user: { $ref: '#/components/schemas/AuthUser' }
 *                     token: { type: string }
 *                     isNewUser: { type: boolean }
 *       400:
 *         description: Identity token missing, or email required for new account
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid or expired Apple identity token
 *       403:
 *         description: Account deactivated
 *       503:
 *         description: Apple Sign In not configured (APPLE_CLIENT_ID missing)
 */
router.post('/apple', appleLogin);

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Request password reset email
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Reset email sent (if email exists)
 */
const forgotPasswordValidation = [body('email').trim().isEmail().withMessage('Valid email is required')];
router.post('/forgot-password', forgotPasswordValidation, handleValidationErrors, forgotPassword);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Reset password with token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - newPassword
 *             properties:
 *               token:
 *                 type: string
 *                 description: Reset token from email
 *               newPassword:
 *                 type: string
 *                 description: New password
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: Invalid or expired token
 */
const resetPasswordValidation = [
  body('token').notEmpty().withMessage('Token is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
];
router.post('/reset-password', resetPasswordValidation, handleValidationErrors, resetPassword);

/**
 * @swagger
 * /auth/change-password/{userId}:
 *   put:
 *     summary: Change password (logged in user)
 *     description: Change password for the authenticated user. userId in path must match the JWT. Requires current password and new password.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         description: User UUID (must match the authenticated user)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 description: Current password for verification
 *                 example: "oldPassword123"
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *                 description: New password (min 6 characters)
 *                 example: "newSecurePass456"
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       400:
 *         description: Bad request (e.g. Google-only account)
 *       401:
 *         description: Current password incorrect or invalid token
 *       403:
 *         description: Forbidden. Token does not match userId.
 *       404:
 *         description: User not found
 */
const changePasswordValidation = [
  param('userId').isUUID().withMessage('Valid user ID is required'),
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
];
router.put('/change-password/:userId', verifyToken, changePasswordValidation, handleValidationErrors, changePassword);

/**
 * @swagger
 * /auth/user/{userId}:
 *   get:
 *     summary: Get user profile by user ID
 *     description: Returns the profile for the given user ID. Caller must be authenticated and can only request their own userId (token must match). Use GET /user/profile for token-based current user profile including preferred language and address.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         description: User UUID (must match the authenticated user)
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     email: { type: string, format: email }
 *                     firstName: { type: string }
 *                     lastName: { type: string }
 *                     role: { type: string }
 *                     status: { type: string }
 *                     avatar: { type: string, nullable: true }
 *                     isEmailVerified: { type: boolean }
 *                     hasPassword: { type: boolean }
 *                     isGoogleUser: { type: boolean }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       401:
 *         description: Access denied. No token or invalid token.
 *       403:
 *         description: Forbidden. Token does not match userId.
 *       404:
 *         description: User not found
 */
router.get('/user/:userId', verifyToken, getMe);

/**
 * @swagger
 * /auth/profile/{userId}:
 *   put:
 *     summary: Update user profile (name, email)
 *     description: Update firstName, lastName, or email for the authenticated user. userId in path must match the JWT. For preferred language and address use PATCH /user/profile/preferred-language and PATCH /user/profile/address.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         description: User UUID (must match the authenticated user)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *                 example: "John"
 *               lastName:
 *                 type: string
 *                 example: "Doe"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "john.doe@example.com"
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Profile updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/AuthUser'
 *       403:
 *         description: Forbidden. Token does not match userId.
 *       404:
 *         description: User not found
 *       409:
 *         description: Email already in use
 */
router.put('/profile/:userId', verifyToken, updateProfile);

/**
 * @swagger
 * /auth/delete-account/{userId}:
 *   delete:
 *     summary: Delete user account
 *     description: Permanently delete the authenticated user's account. userId in path must match the JWT. For email accounts, send current password in body for verification.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         description: User UUID (must match the authenticated user)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               password:
 *                 type: string
 *                 description: Current password (required for email/password accounts; omit for Google-only)
 *                 example: "currentPassword123"
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *       401:
 *         description: Password incorrect (for email accounts)
 *       403:
 *         description: Forbidden. Token does not match userId.
 *       404:
 *         description: User not found
 */
router.delete('/delete-account/:userId', verifyToken, deleteAccount);

module.exports = router;
