const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const {
  getProfile,
  updatePreferredLanguage,
  updateAddress,
} = require('../controllers/auth.controller');
const {
  registerPushToken,
  unregisterPushToken,
  getNotificationPreferences,
  patchNotificationPreferences,
} = require('../controllers/pushNotification.controller');
const { verifyToken } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');

/**
 * @swagger
 * tags:
 *   name: User Profile
 *   description: |
 *     Current user profile by JWT. Profile, language, address, **FCM device registration**, and **push notification preferences** (Amoon Bloom mobile).
 */

/**
 * @swagger
 * /user/profile:
 *   get:
 *     summary: Get current user profile
 *     description: Returns the authenticated user's profile based on the JWT token. Includes optional preferred language, address country, and address city. No userId in path; identity is taken from the Bearer token.
 *     tags: [User Profile]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/UserProfile'
 *             example:
 *               success: true
 *               data:
 *                 id: "550e8400-e29b-41d4-a716-446655440000"
 *                 email: "user@example.com"
 *                 firstName: "John"
 *                 lastName: "Doe"
 *                 avatar: null
 *                 role: "CUSTOMER"
 *                 status: "ACTIVE"
 *                 isEmailVerified: true
 *                 preferredLanguage: "en"
 *                 addressCountry: "United Arab Emirates"
 *                 addressCity: "Dubai"
 *                 createdAt: "2025-01-15T10:00:00.000Z"
 *                 updatedAt: "2025-03-17T12:00:00.000Z"
 *       401:
 *         description: Access denied. No token or invalid/expired token.
 *       404:
 *         description: User not found
 */
router.get('/profile', verifyToken, getProfile);

/**
 * @swagger
 * /user/profile/preferred-language:
 *   patch:
 *     summary: Update preferred language
 *     description: Stores the authenticated user's preferred language (e.g. en, ar). Sent in request body. Identity from JWT.
 *     tags: [User Profile]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PreferredLanguageInput'
 *           example:
 *             preferredLanguage: "ar"
 *     responses:
 *       200:
 *         description: Preferred language updated successfully
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
 *                   example: Preferred language updated successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     preferredLanguage:
 *                       type: string
 *                       nullable: true
 *                       example: "ar"
 *       400:
 *         description: Bad request. preferredLanguage is required.
 *       401:
 *         description: Access denied. No token or invalid token.
 */
const preferredLanguageValidation = [
  body('preferredLanguage').notEmpty().withMessage('preferredLanguage is required'),
];
router.patch('/profile/preferred-language', preferredLanguageValidation, handleValidationErrors, verifyToken, updatePreferredLanguage);

/**
 * @swagger
 * /user/profile/address:
 *   patch:
 *     summary: Update address (country and city)
 *     description: Stores the authenticated user's address country and/or city. Both fields are optional; send at least one. Identity from JWT.
 *     tags: [User Profile]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddressInput'
 *           example:
 *             addressCountry: "United Arab Emirates"
 *             addressCity: "Abu Dhabi"
 *     responses:
 *       200:
 *         description: Address updated successfully
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
 *                   example: Address updated successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     addressCountry:
 *                       type: string
 *                       nullable: true
 *                       example: "United Arab Emirates"
 *                     addressCity:
 *                       type: string
 *                       nullable: true
 *                       example: "Abu Dhabi"
 *       400:
 *         description: Bad request. At least one of addressCountry or addressCity is required.
 *       401:
 *         description: Access denied. No token or invalid token.
 */
const addressValidation = [
  body('addressCountry').optional().trim(),
  body('addressCity').optional().trim(),
];
router.patch('/profile/address', addressValidation, handleValidationErrors, verifyToken, updateAddress);

/**
 * @swagger
 * /user/push/token:
 *   post:
 *     summary: Register FCM device token
 *     description: |
 *       Associates the Firebase Cloud Messaging token with the signed-in user (Amoon Bloom app).
 *       Call after login when FCM provides a token; safe to call again on token refresh.
 *       Optional **platform** — `IOS`, `ANDROID`, or `WEB` (default ANDROID).
 *     tags: [Push notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PushTokenRegister'
 *     responses:
 *       200:
 *         description: Token registered
 *       400:
 *         description: Missing fcmToken
 *       401:
 *         description: Unauthorized
 */
const pushRegisterValidation = [
  body('fcmToken').trim().notEmpty().withMessage('fcmToken is required'),
  body('platform')
    .optional()
    .trim()
    .custom((v) => {
      if (v == null || v === '') return true;
      return ['IOS', 'ANDROID', 'WEB'].includes(String(v).toUpperCase());
    })
    .withMessage('platform must be IOS, ANDROID, or WEB'),
];
router.post('/push/token', pushRegisterValidation, handleValidationErrors, verifyToken, registerPushToken);

/**
 * @swagger
 * /user/push/token:
 *   delete:
 *     summary: Remove FCM device token
 *     description: Unregisters this device so it no longer receives pushes (e.g. on logout).
 *     tags: [Push notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PushTokenUnregister'
 *     responses:
 *       200:
 *         description: Token removed
 *       404:
 *         description: Token not registered for this user
 */
const pushUnregisterValidation = [body('fcmToken').trim().notEmpty().withMessage('fcmToken is required')];
router.delete('/push/token', pushUnregisterValidation, handleValidationErrors, verifyToken, unregisterPushToken);

/**
 * @swagger
 * /user/notifications/preferences:
 *   get:
 *     summary: Get push notification preferences
 *     description: |
 *       Returns toggles for Amoon Bloom push channels. Defaults are **all true** when first loaded.
 *       **orderStatus** — order placed, confirmed, shipped, delivered, cancelled.
 *       **promotions** — reserved for marketing / offers (future).
 *       **announcements** — reserved for app or store announcements (future).
 *     tags: [Push notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Preferences
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   $ref: '#/components/schemas/NotificationPreferences'
 */
router.get('/notifications/preferences', verifyToken, getNotificationPreferences);

/**
 * @swagger
 * /user/notifications/preferences:
 *   patch:
 *     summary: Update push notification preferences
 *     description: Send one or more boolean fields to update. Omitted fields stay unchanged.
 *     tags: [Push notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NotificationPreferencesPatch'
 *     responses:
 *       200:
 *         description: Updated preferences
 *       400:
 *         description: No valid fields sent
 */
const notificationPrefsPatchValidation = [
  body('orderStatus').optional().isBoolean().withMessage('orderStatus must be a boolean'),
  body('promotions').optional().isBoolean().withMessage('promotions must be a boolean'),
  body('announcements').optional().isBoolean().withMessage('announcements must be a boolean'),
];
router.patch(
  '/notifications/preferences',
  notificationPrefsPatchValidation,
  handleValidationErrors,
  verifyToken,
  patchNotificationPreferences
);

module.exports = router;
