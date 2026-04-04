const express = require('express');
const router = express.Router();
const {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  toggleUserStatus,
  changeUserRole,
  getUserStats,
  getManagerPermissionCatalog,
} = require('../controllers/user.controller');
const { verifyAdmin } = require('../middleware/auth');

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create customer or manager
 *     description: |
 *       Requires an **Administrator** JWT.
 *
 *       - **Customer** — Default account; use role CUSTOMER or omit role.
 *       - **Manager** — Use role MANAGER with **managerTitle**, **managerPermissions** (at least one key), and optional **avatar** URL. Load labels from **GET /users/manager-permissions** first.
 *
 *       Attempting to create an **ADMIN** user returns **403**. Use your seed script for the first administrator.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserInput'
 *           examples:
 *             customer:
 *               summary: New customer
 *               value:
 *                 email: newcustomer@example.com
 *                 firstName: Jane
 *                 lastName: Doe
 *                 password: 'SecurePass1!'
 *                 role: CUSTOMER
 *                 status: ACTIVE
 *             manager:
 *               summary: New manager (orders + products)
 *               value:
 *                 email: ops@example.com
 *                 firstName: Sam
 *                 lastName: Lee
 *                 password: 'SecurePass1!'
 *                 role: MANAGER
 *                 managerTitle: Operations lead
 *                 managerPermissions: [ORDERS, PRODUCTS]
 *                 avatar: https://cdn.example.com/uploads/manager.jpg
 *     responses:
 *       201:
 *         description: Created; body matches GET user shape (title-cased role/status)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation error (e.g. manager missing title or permissions)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid token
 *       403:
 *         description: Not admin, or attempted to create ADMIN
 *       409:
 *         description: Email already registered
 */

/**
 * @swagger
 * /users:
 *   get:
 *     summary: List users (paginated, filterable)
 *     description: |
 *       Requires an **Administrator** JWT.
 *
 *       Paginated list. **role** and **status** in each row are title-cased for display. Managers include **managerTitle** and **managerPermissions**.
 *
 *       **Filters** — page, limit, optional search (email or name), role (CUSTOMER / ADMIN / MANAGER), status (ACTIVE / INACTIVE), sortBy, order (asc or desc).
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Case-insensitive match on email, firstName, lastName
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [CUSTOMER, ADMIN, MANAGER] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, INACTIVE] }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [firstName, lastName, email, createdAt, role, status] }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: List in data; pagination in meta.pagination
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/User'
 *                     meta:
 *                       type: object
 *                       properties:
 *                         pagination:
 *                           type: object
 *                           properties:
 *                             page: { type: integer }
 *                             limit: { type: integer }
 *                             total: { type: integer }
 *                             totalPages: { type: integer }
 *                             hasNext: { type: boolean }
 *                             hasPrev: { type: boolean }
 *       401:
 *         description: Missing or invalid token
 *       403:
 *         description: Not admin
 */
router.post('/', verifyAdmin, createUser);
router.get('/', verifyAdmin, getAllUsers);

/**
 * @swagger
 * /users/stats:
 *   get:
 *     summary: User counts for admin dashboard
 *     description: |
 *       Requires an **Administrator** JWT. Returns dashboard totals: all users, customers, admins, managers, and active vs inactive counts.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/UserStats'
 *       401:
 *         description: Missing or invalid token
 *       403:
 *         description: Not admin
 */
router.get('/stats', verifyAdmin, getUserStats);

/**
 * @swagger
 * /users/manager-permissions:
 *   get:
 *     summary: Catalog of manager permission keys (for admin UI)
 *     description: |
 *       Requires an **Administrator** JWT.
 *
 *       Use **data.permissions** from the response to build checkboxes or toggles when creating or editing a manager. Each item includes:
 *
 *       - **key** — Send this string in the **managerPermissions** array on user APIs.
 *       - **label** — Short title for the UI.
 *       - **description** — Longer text for tooltips or help panels.
 *
 *       These keys match what the server enforces after a manager signs in.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Response field data.permissions is the array to bind to your UI
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ManagerPermissionCatalog'
 *             example:
 *               success: true
 *               message: Manager permission catalog fetched successfully
 *               data:
 *                 permissions:
 *                   - key: PRODUCTS
 *                     label: Products
 *                     description: Create, update, and delete products
 *                   - key: ORDERS
 *                     label: Orders
 *                     description: List all orders, view any order, update order status
 *       401:
 *         description: Missing or invalid token
 *       403:
 *         description: Not admin
 */
router.get('/manager-permissions', verifyAdmin, getManagerPermissionCatalog);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get one user by ID
 *     description: |
 *       Requires an **Administrator** JWT. Returns one user in the same shape as the list endpoint, including manager fields when relevant.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/User'
 *       404:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update user (profile, role, manager fields)
 *     description: |
 *       Requires an **Administrator** JWT. Send only fields you want to change.
 *
 *       For **manager** accounts, **managerTitle** and **managerPermissions** must stay valid (server checks the final state). Changing role away from **MANAGER** clears job title and permissions.
 *     tags: [Users]
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
 *           schema:
 *             $ref: '#/components/schemas/UserUpdateInput'
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete user
 *     description: |
 *       Requires an **Administrator** JWT. Permanently deletes the account. Confirm your business rules (e.g. users with past orders) before calling.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Success; data may be null with a message
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
 *       404:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', verifyAdmin, getUserById);
router.put('/:id', verifyAdmin, updateUser);
router.delete('/:id', verifyAdmin, deleteUser);

/**
 * @swagger
 * /users/{id}/status:
 *   patch:
 *     summary: Set account ACTIVE or INACTIVE
 *     description: |
 *       Requires an **Administrator** JWT. Set **status** to ACTIVE or INACTIVE in the JSON body, or omit the body to toggle. Inactive users are blocked from protected APIs.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, INACTIVE]
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/User'
 *       404:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch('/:id/status', verifyAdmin, toggleUserStatus);

/**
 * @swagger
 * /users/{id}/role:
 *   patch:
 *     summary: Change role (customer / admin / manager)
 *     description: |
 *       Requires an **Administrator** JWT. Sets **role** to CUSTOMER, ADMIN, or MANAGER.
 *
 *       For **MANAGER**, include **managerTitle** and **managerPermissions** with at least one key (use **GET /users/manager-permissions** to drive the UI). Any other role clears manager title and permissions.
 *     tags: [Users]
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
 *           schema:
 *             $ref: '#/components/schemas/ChangeUserRoleInput'
 *           examples:
 *             toManager:
 *               summary: Promote to manager
 *               value:
 *                 role: MANAGER
 *                 managerTitle: Support lead
 *                 managerPermissions: [CONTACT, ORDERS]
 *             toCustomer:
 *               summary: Demote to customer
 *               value:
 *                 role: CUSTOMER
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch('/:id/role', verifyAdmin, changeUserRole);

module.exports = router;
