const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const addressController = require('../controllers/address.controller');
const { verifyToken } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');

/**
 * @swagger
 * tags:
 *   name: Addresses
 *   description: Saved shipping addresses for the authenticated user.
 */

const idParam = [param('id').isUUID().withMessage('Valid address ID required')];

// All address fields are optional. fullName/phone are sourced from the user profile
// at checkout time; streetAddress/city/country are typically pre-filled from the
// user's saved profile values (addressCity, addressCountry) on the client.
const addressBody = [
  body('fullName').optional({ checkFalsy: true }).trim(),
  body('phone').optional({ checkFalsy: true }).trim(),
  body('streetAddress').optional({ checkFalsy: true }).trim(),
  body('city').optional({ checkFalsy: true }).trim(),
  body('country').optional({ checkFalsy: true }).trim(),
  body('label').optional({ checkFalsy: true }).trim(),
  body('apartment').optional({ checkFalsy: true }).trim(),
  body('state').optional({ checkFalsy: true }).trim(),
  body('postalCode').optional({ checkFalsy: true }).trim(),
  body('area').optional({ checkFalsy: true }).trim(),
  body('deliveryZoneId').optional({ checkFalsy: true }).isUUID().withMessage('deliveryZoneId must be a valid id'),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be a boolean'),
];

const addressPatchBody = [
  body('fullName').optional({ checkFalsy: true }).trim(),
  body('phone').optional({ checkFalsy: true }).trim(),
  body('streetAddress').optional({ checkFalsy: true }).trim(),
  body('city').optional({ checkFalsy: true }).trim(),
  body('country').optional({ checkFalsy: true }).trim(),
  body('label').optional({ checkFalsy: true }).trim(),
  body('apartment').optional({ checkFalsy: true }).trim(),
  body('state').optional({ checkFalsy: true }).trim(),
  body('postalCode').optional({ checkFalsy: true }).trim(),
  body('area').optional({ checkFalsy: true }).trim(),
  body('deliveryZoneId').optional({ checkFalsy: true }).isUUID().withMessage('deliveryZoneId must be a valid id'),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be a boolean'),
];

/**
 * @swagger
 * /user/addresses:
 *   get:
 *     summary: List saved addresses
 *     description: |
 *       Returns all shipping addresses saved by the authenticated user, default address first.
 *
 *       Newly-created addresses (after May 2026) typically have `fullName` and `phone` as **null** — those values now live on the user profile and are stamped onto orders at checkout. Older addresses created before the simplified form may still carry recipient name/phone in these fields.
 *     tags: [Addresses]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of addresses
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *             example:
 *               success: true
 *               data:
 *                 - id: "550e8400-e29b-41d4-a716-446655440000"
 *                   label: "Home"
 *                   fullName: null
 *                   phone: null
 *                   streetAddress: "Villa 14, Al Wasl Road"
 *                   apartment: null
 *                   city: "Dubai"
 *                   state: "Dubai"
 *                   postalCode: null
 *                   country: "United Arab Emirates"
 *                   isDefault: true
 */
router.get('/', verifyToken, addressController.list);

/**
 * @swagger
 * /user/addresses:
 *   post:
 *     summary: Add a new address (minimal form)
 *     description: |
 *       Saves a new shipping address for the user.
 *
 *       **All fields are optional** — you can post an empty body `{}` or just the location bits. Recipient `fullName` and `phone` are **not collected here**; they're read from the user profile (collected at signup / Google / Apple login) and stamped onto orders at checkout.
 *
 *       Recommended client behavior — pre-fill `city` and `country` in the form from the user profile (`addressCity`, `addressCountry` on `GET /user/profile`), let the user edit, then submit. The first address is automatically set as default. Pass `isDefault: true` to immediately make this the default (unsets all others).
 *     tags: [Addresses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AddressInput' }
 *           examples:
 *             minimal:
 *               summary: Typical new address (pre-filled location, no recipient fields)
 *               value:
 *                 streetAddress: "Villa 14, Al Wasl Road"
 *                 city: "Dubai"
 *                 country: "United Arab Emirates"
 *             empty:
 *               summary: Empty body — all defaults
 *               value: {}
 *             withLabel:
 *               summary: With label and apartment
 *               value:
 *                 label: "Home"
 *                 streetAddress: "Villa 14, Al Wasl Road"
 *                 apartment: "Apt 401"
 *                 city: "Dubai"
 *                 country: "United Arab Emirates"
 *                 isDefault: true
 *     responses:
 *       201:
 *         description: Address created
 *       400:
 *         description: Validation error (e.g. address limit reached, invalid `isDefault`)
 */
router.post('/', verifyToken, addressBody, handleValidationErrors, addressController.create);

/**
 * @swagger
 * /user/addresses/{id}:
 *   patch:
 *     summary: Update a saved address
 *     description: |
 *       Partial update — send only the fields you want to change. Same field shape as POST: every field is optional and recipient name/phone are normally not edited here.
 *     tags: [Addresses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AddressInput' }
 *           example:
 *             city: "Abu Dhabi"
 *             country: "United Arab Emirates"
 *             label: "Home"
 *     responses:
 *       200:
 *         description: Address updated
 *       404:
 *         description: Address not found
 */
router.patch('/:id', verifyToken, idParam, addressPatchBody, handleValidationErrors, addressController.update);

/**
 * @swagger
 * /user/addresses/{id}:
 *   delete:
 *     summary: Delete a saved address
 *     description: Deletes the address. If it was the default, the next most-recent address is promoted to default.
 *     tags: [Addresses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Address deleted
 *       404:
 *         description: Address not found
 */
router.delete('/:id', verifyToken, idParam, handleValidationErrors, addressController.remove);

/**
 * @swagger
 * /user/addresses/{id}/default:
 *   patch:
 *     summary: Set address as default
 *     description: Makes this address the default shipping address and unsets all others.
 *     tags: [Addresses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Default address updated
 *       404:
 *         description: Address not found
 */
router.patch('/:id/default', verifyToken, idParam, handleValidationErrors, addressController.setDefault);

module.exports = router;

