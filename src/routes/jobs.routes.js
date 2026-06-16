const express = require('express');
const router = express.Router();
const jobsController = require('../controllers/jobs.controller');
const { verifyAdminOrManager, requireAnyManagerPermission } = require('../middleware/managerAuth');

/**
 * @swagger
 * tags:
 *   name: Background jobs
 *   description: Admin view of the background-job engine (pg-boss) + manual triggers and broadcasts.
 */

// Self-contained dashboard. Public shell (no data); it authenticates its own fetches
// with an admin token entered by the operator, so nothing sensitive is served here.
router.get('/ui', jobsController.ui);

const adminGuard = [verifyAdminOrManager, requireAnyManagerPermission(['SETTINGS', 'ORDERS'])];

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
router.post('/broadcast', adminGuard, jobsController.broadcast);

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
