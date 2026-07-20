const express = require('express');
const router = express.Router();
const jobsController = require('../controllers/jobs.controller');
const { verifyAdminOrManager, requireAnyManagerPermission, requireManagerPermission } = require('../middleware/managerAuth');

/**
 * @swagger
 * tags:
 *   name: Background jobs
 *   description: Admin view of the background-job engine (pg-boss) + manual triggers and broadcasts.
 */

// Self-contained dashboard. Public shell (no data); it authenticates its own fetches
// with an admin token entered by the operator, so nothing sensitive is served here.
router.get('/ui', jobsController.ui);

// Job-engine status + manual re-runs: an operational concern, kept on the
// broad SETTINGS/ORDERS guard (this is the standalone /admin/jobs ops tool,
// not a delegatable admin-panel nav area).
const adminGuard = [verifyAdminOrManager, requireAnyManagerPermission(['SETTINGS', 'ORDERS'])];

// Broadcasting a push reaches the entire customer base, so it has its own
// dedicated permission — an order-processing manager must not be able to send
// marketing blasts just because they can also see the job engine.
const broadcastGuard = [verifyAdminOrManager, requireManagerPermission('NOTIFICATIONS')];

/**
 * @swagger
 * /admin/jobs:
 *   get:
 *     summary: Background-job engine status
 *     description: Engine readiness + per-queue pending counts and schedules. **Admin** or **manager (SETTINGS/ORDERS)**.
 *     tags: [Background jobs]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Status }
 */
router.get('/', adminGuard, jobsController.status);

/**
 * @swagger
 * /admin/jobs/broadcast:
 *   post:
 *     summary: Broadcast a promotion/announcement push
 *     description: Enqueue a push broadcast to customers. **Admin** or **manager (NOTIFICATIONS)**.
 *     tags: [Background jobs]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, body]
 *             properties:
 *               kind: { type: string, enum: [promotion, announcement] }
 *               title: { type: string }
 *               body: { type: string }
 *               regionId: { type: string }
 *               data: { type: object }
 *     responses:
 *       202: { description: Broadcast queued }
 */
router.post('/broadcast', broadcastGuard, jobsController.broadcast);

/**
 * @swagger
 * /admin/jobs/{queue}/run:
 *   post:
 *     summary: Run a scheduled job immediately
 *     tags: [Background jobs]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: queue
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       202: { description: Job triggered }
 *       404: { description: Unknown or non-runnable queue }
 */
router.post('/:queue/run', adminGuard, jobsController.runNow);

module.exports = router;
