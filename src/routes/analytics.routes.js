const express = require('express');
const { query } = require('express-validator');
const router = express.Router();
const analyticsController = require('../controllers/analytics.controller');
const { verifyAdminOrManager, requireAnyManagerPermission } = require('../middleware/managerAuth');
const { handleValidationErrors } = require('../middleware/validate');
const analyticsService = require('../services/analytics.service');

/**
 * @swagger
 * tags:
 *   name: Admin analytics
 *   description: |
 *     Revenue and order metrics for the admin dashboard (charts). **Admin** or **manager with ORDERS** (or **SETTINGS**).
 *     All ranges are **UTC**; map to store-local in the client if needed.
 *     **Revenue** (time series) sums `Order.totalAmount` for rows where `status <> CANCELLED`. **GET …/kpi** totals. **GET …/revenue/by-category** ranks categories. **GET …/sales/by-day** = per-calendar-day net sales (gap-filled). Preset **all_time** uses monthly buckets on revenue and sales-by-day routes.
 */

const presetValues = analyticsService.PRESETS;

/**
 * @swagger
 * /admin/analytics/presets:
 *   get:
 *     summary: List revenue analytics presets
 *     description: Returns preset keys, human labels, and default time bucket (hour, day, month, year) for building date-range controls.
 *     tags: [Admin analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Preset catalog
 */
router.get(
  '/presets',
  verifyAdminOrManager,
  requireAnyManagerPermission(['ORDERS', 'SETTINGS']),
  analyticsController.listPresets
);

/**
 * @swagger
 * /admin/analytics/revenue:
 *   get:
 *     summary: Revenue & order analytics (time series)
 *     description: |
 *       Three parallel aggregate queries (summary, time **series**, **byStatus**). Uses indexed `Order(createdAt, status)`.
 *       Query **preset** *or* both **from** and **to** (ISO dates, interpreted as UTC calendar days for custom ranges).
 *     tags: [Admin analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: preset
 *         schema:
 *           type: string
 *           enum: [all_time, today, last_3_days, week, month, last_3_months, last_6_months, year, last_3_years]
 *         description: Ignored if from+to are set
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: summary, series (for charts), byStatus breakdown
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/ApiSuccess' }
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/RevenueAnalyticsPayload' }
 *       400:
 *         description: Invalid preset or range
 */
router.get(
  '/revenue',
  verifyAdminOrManager,
  requireAnyManagerPermission(['ORDERS', 'SETTINGS']),
  [
    query('preset').optional().isIn(presetValues),
    query('from').optional().trim().isString(),
    query('to').optional().trim().isString(),
  ],
  handleValidationErrors,
  analyticsController.getRevenue
);

/**
 * @swagger
 * /admin/analytics/kpi:
 *   get:
 *     summary: Dashboard KPIs (totals & per-status)
 *     description: |
 *       **Two parallel SQL aggregates:** one row of conditional counts/sums on `Order`, plus **unitsSold** from `OrderItem` (non-cancelled orders only).
 *       Returns **netRevenue** / **netSalesCount** (excluding cancelled), **grossRevenueAllStatuses**, **cancelled**, and **byStatus** (PENDING, CONFIRMED, PROCESSING, SHIPPED, DELIVERED, CANCELLED) with order counts and revenue each.
 *     tags: [Admin analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: preset
 *         schema:
 *           type: string
 *           enum: [all_time, today, last_3_days, week, month, last_3_months, last_6_months, year, last_3_years]
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: KPI payload
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/ApiSuccess' }
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/KpiAnalyticsPayload' }
 */
router.get(
  '/kpi',
  verifyAdminOrManager,
  requireAnyManagerPermission(['ORDERS', 'SETTINGS']),
  [
    query('preset').optional().isIn(presetValues),
    query('from').optional().trim().isString(),
    query('to').optional().trim().isString(),
  ],
  handleValidationErrors,
  analyticsController.getKpi
);

/**
 * @swagger
 * /admin/analytics/revenue/by-category:
 *   get:
 *     summary: Net sales by category (ranked)
 *     description: |
 *       One grouped query: joins **Order → OrderItem → Product → Category**. Revenue is **Σ (quantity × line price)** on **non-cancelled** orders (aligns with captured line totals). Includes **rank** and **revenueSharePercent** for bar/pie charts (e.g. “last week Women outsold Accessories”).
 *     tags: [Admin analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: preset
 *         schema:
 *           type: string
 *           enum: [all_time, today, last_3_days, week, month, last_3_months, last_6_months, year, last_3_years]
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Ranked categories
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/ApiSuccess' }
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/CategorySalesAnalyticsPayload' }
 */
router.get(
  '/revenue/by-category',
  verifyAdminOrManager,
  requireAnyManagerPermission(['ORDERS', 'SETTINGS']),
  [
    query('preset').optional().isIn(presetValues),
    query('from').optional().trim().isString(),
    query('to').optional().trim().isString(),
  ],
  handleValidationErrors,
  analyticsController.getCategorySales
);

/**
 * @swagger
 * /admin/analytics/sales/by-day:
 *   get:
 *     summary: Sales by calendar day (UTC)
 *     description: |
 *       **One SQL** `GROUP BY date_trunc('day', …)` on `Order` (indexed `createdAt`). Returns every day in the range with **zeros** on days with no orders — ideal for bar/line charts (“how many sales each day”).
 *       **netOrderCount** / **netRevenue** exclude **CANCELLED**; cancelled counts/revenue are per day too.
 *       Preset **all_time** returns **monthly** buckets instead (see **granularity**).
 *     tags: [Admin analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: preset
 *         schema:
 *           type: string
 *           enum: [all_time, today, last_3_days, week, month, last_3_months, last_6_months, year, last_3_years]
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: points[] + summary (includes bestDay when granularity is day)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/ApiSuccess' }
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/DailySalesAnalyticsPayload' }
 */
router.get(
  '/sales/by-day',
  verifyAdminOrManager,
  requireAnyManagerPermission(['ORDERS', 'SETTINGS']),
  [
    query('preset').optional().isIn(presetValues),
    query('from').optional().trim().isString(),
    query('to').optional().trim().isString(),
  ],
  handleValidationErrors,
  analyticsController.getDailySales
);

module.exports = router;
