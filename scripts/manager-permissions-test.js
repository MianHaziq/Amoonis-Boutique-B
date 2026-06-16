/**
 * Verifies the ANALYTICS + REGIONS manager-permission wiring:
 *   1. Catalog + validator expose the two new keys.
 *   2. Analytics routes require the ANALYTICS permission (was ORDERS/SETTINGS).
 *   3. Region CRUD routes require the REGIONS permission (was SETTINGS).
 *   4. Admins bypass all checks; managers are gated to exactly their grants.
 *
 * Hits the REAL routers (mounted on an ephemeral port) through the REAL
 * verifyAdminOrManager + requireManagerPermission middleware, so the test
 * exercises the actual permission chain — not a mock.
 *
 *   node scripts/manager-permissions-test.js
 */
require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/db');
const analyticsRoutes = require('../src/routes/analytics.routes');
const regionRoutes = require('../src/routes/region.routes');
const {
  MANAGER_PERMISSION_VALUES,
  MANAGER_PERMISSION_CATALOG,
  normalizeManagerPermissions,
} = require('../src/constants/managerPermissions');

const TAG = `mpt_${Date.now()}`;
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const sign = (user) =>
  jwt.sign({ id: user.id, role: user.role, tv: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });

async function mkManager(perms) {
  return prisma.user.create({
    data: {
      email: `${TAG}_${Math.random().toString(36).slice(2)}@e.com`,
      role: 'MANAGER',
      status: 'ACTIVE',
      managerTitle: 'Test Manager',
      managerPermissions: perms,
    },
  });
}
async function mkAdmin() {
  return prisma.user.create({
    data: { email: `${TAG}_admin@e.com`, role: 'ADMIN', status: 'ACTIVE' },
  });
}

(async () => {
  const createdUserIds = [];
  const createdRegionIds = [];
  let server;

  try {
    console.log('\n=== Manager permissions: ANALYTICS + REGIONS verification ===\n');

    // ---- 1. Constants / validator -------------------------------------------
    console.log('-- catalog & validator --');
    check('ANALYTICS in MANAGER_PERMISSION_VALUES', MANAGER_PERMISSION_VALUES.includes('ANALYTICS'));
    check('REGIONS in MANAGER_PERMISSION_VALUES', MANAGER_PERMISSION_VALUES.includes('REGIONS'));
    check(
      'ANALYTICS present in catalog with a label',
      MANAGER_PERMISSION_CATALOG.some((c) => c.key === 'ANALYTICS' && !!c.label)
    );
    check(
      'REGIONS present in catalog with a label',
      MANAGER_PERMISSION_CATALOG.some((c) => c.key === 'REGIONS' && !!c.label)
    );
    const norm = normalizeManagerPermissions(['analytics', 'regions']);
    check(
      'normalizeManagerPermissions accepts the new keys (case-insensitive)',
      norm.ok && norm.value.includes('ANALYTICS') && norm.value.includes('REGIONS'),
      norm.ok ? norm.value.join(',') : norm.message
    );

    // ---- Build users --------------------------------------------------------
    const admin = await mkAdmin();
    const mAnalytics = await mkManager(['ANALYTICS']);
    const mRegions = await mkManager(['REGIONS']);
    const mBoth = await mkManager(['ANALYTICS', 'REGIONS']);
    const mProducts = await mkManager(['PRODUCTS']); // neither permission
    [admin, mAnalytics, mRegions, mBoth, mProducts].forEach((u) => createdUserIds.push(u.id));

    // ---- Mount the real routers on an ephemeral port ------------------------
    const app = express();
    app.use(express.json());
    app.use('/api/admin/analytics', analyticsRoutes);
    app.use('/api/regions', regionRoutes);
    // Minimal error handler so any unexpected next(err) surfaces as 500 (not a hang).
    app.use((err, req, res, _next) => res.status(500).json({ success: false, message: err.message }));

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const callGet = async (path, user) => {
      const res = await fetch(`${base}${path}`, {
        headers: user ? { Authorization: `Bearer ${sign(user)}` } : {},
      });
      return res.status;
    };
    const callPost = async (path, user, body) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    };

    // ---- 2. Analytics routes require ANALYTICS ------------------------------
    // KPI endpoint requires a preset (or from+to); that validation runs AFTER the
    // permission gate, so denied callers still get 403 before it matters.
    const KPI = '/api/admin/analytics/kpi?preset=month';
    console.log('\n-- analytics routes (GET /api/admin/analytics/kpi) --');
    check('admin → 200', (await callGet(KPI, admin)) === 200);
    check('manager[ANALYTICS] → 200', (await callGet(KPI, mAnalytics)) === 200);
    check('manager[ANALYTICS+REGIONS] → 200', (await callGet(KPI, mBoth)) === 200);
    check('manager[REGIONS only] → 403', (await callGet(KPI, mRegions)) === 403);
    check('manager[PRODUCTS only] → 403', (await callGet(KPI, mProducts)) === 403);
    check('no token → 401', (await callGet(KPI, null)) === 401);

    // ---- 3. Region CRUD routes require REGIONS ------------------------------
    // The permission middleware runs BEFORE validation, so a denied caller gets
    // 403 regardless of body. Allowed callers reach the controller; we send a
    // real unique region and clean it up.
    console.log('\n-- region create (POST /api/regions) --');
    check(
      'manager[ANALYTICS only] → 403',
      (await callPost('/api/regions', mAnalytics, { code: `${TAG}_X1`, name: 'X1' })).status === 403
    );
    check(
      'manager[PRODUCTS only] → 403',
      (await callPost('/api/regions', mProducts, { code: `${TAG}_X2`, name: 'X2' })).status === 403
    );

    const rRegions = await callPost('/api/regions', mRegions, { code: `${TAG}_RG`, name: 'Region RG' });
    check('manager[REGIONS] → not 403 (reaches controller)', rRegions.status !== 403, `status ${rRegions.status}`);
    check('manager[REGIONS] → 201 created', rRegions.status === 201);
    if (rRegions.json?.data?.id) createdRegionIds.push(rRegions.json.data.id);

    const rAdmin = await callPost('/api/regions', admin, { code: `${TAG}_AD`, name: 'Region AD' });
    check('admin → 201 created', rAdmin.status === 201, `status ${rAdmin.status}`);
    if (rAdmin.json?.data?.id) createdRegionIds.push(rAdmin.json.data.id);

    console.log(`\n${fail === 0 ? '🎉 ALL PASSED' : '⚠️  SOME FAILED'} — pass: ${pass}, fail: ${fail}\n`);
  } catch (err) {
    console.error('\n💥 Test crashed:', err);
    fail++;
  } finally {
    // Cleanup — leave the DB exactly as we found it.
    if (createdRegionIds.length) {
      await prisma.region.deleteMany({ where: { id: { in: createdRegionIds } } }).catch(() => {});
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
    if (server) await new Promise((r) => server.close(r));
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
