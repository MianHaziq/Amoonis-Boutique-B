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

const addressBody = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('streetAddress').trim().notEmpty().withMessage('Street address is required'),
  body('city').trim().notEmpty().withMessage('City is required'),
  body('country').trim().notEmpty().withMessage('Country is required'),
  body('label').optional().trim(),
  body('apartment').optional().trim(),
  body('state').optional().trim(),
  body('postalCode').optional().trim(),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be a boolean'),
];

const addressPatchBody = [
  body('fullName').optional().trim().notEmpty().withMessage('Full name cannot be empty'),
  body('phone').optional().trim().notEmpty().withMessage('Phone cannot be empty'),
  body('streetAddress').optional().trim().notEmpty().withMessage('Street address cannot be empty'),
  body('city').optional().trim().notEmpty().withMessage('City cannot be empty'),
  body('country').optional().trim().notEmpty().withMessage('Country cannot be empty'),
  body('label').optional().trim(),
  body('apartment').optional().trim(),
  body('state').optional().trim(),
  body('postalCode').optional().trim(),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be a boolean'),
];

/**
 * @swagger
 * /user/addresses:
 *   get:
 *     summary: List saved addresses
 *     description: Returns all shipping addresses saved by the authenticated user, default address first.
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
 *                   fullName: "Ahmed Al Mansouri"
 *                   phone: "+971501234567"
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
 *     summary: Add a new address
 *     description: |
 *       Saves a new shipping address for the user. The first address is automatically set as default.
 *       Pass `isDefault: true` to immediately make this the default (unsets all others).
 *     tags: [Addresses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AddressInput' }
 *           example:
 *             label: "Home"
 *             fullName: "Ahmed Al Mansouri"
 *             phone: "+971501234567"
 *             streetAddress: "Villa 14, Al Wasl Road"
 *             apartment: null
 *             city: "Dubai"
 *             state: "Dubai"
 *             postalCode: null
 *             country: "United Arab Emirates"
 *             isDefault: true
 *     responses:
 *       201:
 *         description: Address created
 *       400:
 *         description: Validation error
 */
router.post('/', verifyToken, addressBody, handleValidationErrors, addressController.create);

/**
 * @swagger
 * /user/addresses/{id}:
 *   patch:
 *     summary: Update a saved address
 *     description: Partial update — send only the fields you want to change.
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
