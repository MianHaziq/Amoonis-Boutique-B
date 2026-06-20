/**
 * End-to-end test for the notification module changes.
 *
 * Exercises the real database but stubs the push.send / push.broadcast WORKERS, so no
 * real FCM messages are delivered and no live users are notified. Creates marked test
 * data and removes it in a finally block.
 *
 * Run: node scripts/notif-e2e-test.js
 */

require('dotenv').config();

const prisma = require('../src/config/db');
const queue = require('../src/jobs/queue');
const { QUEUES } = require('../src/jobs/queues');

const prefsService = require('../src/services/notificationPreferences.service');
const inboxService = require('../src/services/notification.service');
const broadcastJob = require('../src/jobs/handlers/broadcast.job');
const promoAnnounceJob = require('../src/jobs/handlers/promoAnnounce.job');
const adminOrderAlertJob = require('../src/jobs/handlers/adminOrderAlert.job');
const cleanupDefs = require('../src/jobs/handlers/cleanup.job');

const TAG = `e2e-${Date.now()}`;
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Stubbed workers consume the durable jobs (so the queue drains) without real FCM.
const recorded = { pushSend: [], broadcast: [] };

async function makeUser({ ageDays = 0, status = 'ACTIVE', role = 'CUSTOMER' } = {}) {
  const createdAt = new Date(Date.now() - ageDays * 86_400_000);
  return prisma.user.create({
    data: {
      email: `${TAG}-${Math.random().toString(36).slice(2)}@test.local`,
      fullName: `Notif E2E ${TAG}`,
      status,
      role,
      createdAt,
    },
  });
}

async function run() {
  console.log(`\n=== Notification module E2E (${TAG}) ===\n`);

  // Register STUB workers so durable jobs are consumed without real FCM / fan-out.
  // Fast polling + larger batch so the test drains the queue quickly.
  const fast = { pollingIntervalSeconds: 1, batchSize: 25 };
  queue.register(QUEUES.PUSH_SEND, async (data) => { recorded.pushSend.push(data); }, fast);
  queue.register(QUEUES.PUSH_BROADCAST, async (data) => { recorded.broadcast.push(data); }, fast);
  const engineUp = await queue.start();
  check('job engine started (pg-boss)', engineUp === true);

  // ---------------------------------------------------------------------------
  // 1) Preferences service — defaults, concurrency-safe getOrCreate, update
  // ---------------------------------------------------------------------------
  console.log('\n[1] Notification preferences');
  const prefUser = await makeUser();

  const def = await prefsService.getOrCreate(prefUser.id);
  check('defaults are all ON', def.orderStatus && def.promotions && def.announcements);

  // The critical fix: concurrent getOrCreate on a brand-new user must not throw P2002.
  await prisma.userNotificationPreferences.deleteMany({ where: { userId: prefUser.id } });
  const concurrent = await Promise.allSettled(
    Array.from({ length: 8 }, () => prefsService.getOrCreate(prefUser.id))
  );
  const rejected = concurrent.filter((r) => r.status === 'rejected');
  check('8x concurrent getOrCreate — no race/throw', rejected.length === 0,
    rejected.map((r) => r.reason && r.reason.code).join(','));
  const rowCount = await prisma.userNotificationPreferences.count({ where: { userId: prefUser.id } });
  check('exactly one preferences row created', rowCount === 1, `rows=${rowCount}`);

  const upd = await prefsService.update(prefUser.id, { promotions: false });
  check('update toggles only the given channel', upd.promotions === false && upd.orderStatus === true);
  const reread = await prefsService.getOrCreate(prefUser.id);
  check('update persisted', reread.promotions === false);

  // update on a user with NO row yet must create it atomically (upsert).
  const prefUser2 = await makeUser();
  await prisma.userNotificationPreferences.deleteMany({ where: { userId: prefUser2.id } });
  const upd2 = await prefsService.update(prefUser2.id, { announcements: false });
  check('update creates row when missing (upsert)', upd2.announcements === false && upd2.orderStatus === true);

  // ---------------------------------------------------------------------------
  // 2) Inbox service — create, list, unread count, mark read, mark all read
  // ---------------------------------------------------------------------------
  console.log('\n[2] In-app inbox');
  const inboxUser = await makeUser();
  const n1 = await inboxService.create({ userId: inboxUser.id, type: 'ORDER_PLACED', title: 'A', body: 'a', data: { type: 'ORDER_PLACED', orderId: 'x' } });
  await inboxService.create({ userId: inboxUser.id, type: 'PROMOTION', title: 'B', body: 'b' });
  await inboxService.create({ userId: inboxUser.id, type: 'ANNOUNCEMENT', title: 'C', body: 'c' });

  const list1 = await inboxService.list(inboxUser.id, { page: 1, limit: 20 });
  check('list returns all 3, newest first', list1.total === 3 && list1.data[0].title === 'C');
  check('unreadCount = 3', list1.unreadCount === 3);

  const mr = await inboxService.markRead(inboxUser.id, n1.id);
  check('markRead affects 1', mr === 1);
  check('markRead is idempotent (0 on already-read)', (await inboxService.markRead(inboxUser.id, n1.id)) === 0);
  check('unreadCount = 2 after read', (await inboxService.unreadCount(inboxUser.id)) === 2);

  // ownership: another user cannot mark this user's notification
  const otherUser = await makeUser();
  check('markRead is owner-scoped', (await inboxService.markRead(otherUser.id, n1.id)) === 0);

  const mar = await inboxService.markAllRead(inboxUser.id);
  check('markAllRead clears the rest', mar === 2 && (await inboxService.unreadCount(inboxUser.id)) === 0);
  const unreadList = await inboxService.list(inboxUser.id, { unreadOnly: true });
  check('unreadOnly list empty after markAllRead', unreadList.total === 0);

  // ---------------------------------------------------------------------------
  // 3) Inbox retention cleanup job
  // ---------------------------------------------------------------------------
  console.log('\n[3] Inbox retention cleanup');
  const cleanupUser = await makeUser();
  const cleanupNotifDef = cleanupDefs.find((d) => d.queue === QUEUES.CLEANUP_NOTIFICATIONS);
  check('cleanup.notifications job is registered', Boolean(cleanupNotifDef));

  // old + read  -> should be deleted (past NOTIFICATION_RETAIN_DAYS default 90)
  const oldRead = await prisma.notification.create({
    data: { userId: cleanupUser.id, type: 'X', title: 'old-read', body: '.', readAt: new Date(), createdAt: new Date(Date.now() - 120 * 86_400_000) },
  });
  // recent + read -> should be kept
  const recentRead = await prisma.notification.create({
    data: { userId: cleanupUser.id, type: 'X', title: 'recent-read', body: '.', readAt: new Date(), createdAt: new Date(Date.now() - 5 * 86_400_000) },
  });
  // very old + unread -> should be deleted (past NOTIFICATION_UNREAD_RETAIN_DAYS default 180)
  const oldUnread = await prisma.notification.create({
    data: { userId: cleanupUser.id, type: 'X', title: 'old-unread', body: '.', createdAt: new Date(Date.now() - 365 * 86_400_000) },
  });

  await cleanupNotifDef.handler();
  const survivors = await prisma.notification.findMany({ where: { userId: cleanupUser.id }, select: { id: true } });
  const ids = survivors.map((s) => s.id);
  check('old read notification purged', !ids.includes(oldRead.id));
  check('very old unread notification purged', !ids.includes(oldUnread.id));
  check('recent read notification retained', ids.includes(recentRead.id));

  // ---------------------------------------------------------------------------
  // 4) Broadcast audience filter (all vs new_users)
  // ---------------------------------------------------------------------------
  console.log('\n[4] Broadcast audience filter');
  // Two marked users: one brand-new, one old. Both ACTIVE.
  const newU = await makeUser({ ageDays: 0 });
  const oldU = await makeUser({ ageDays: 400 });

  const totalActive = await prisma.user.count({ where: { status: 'ACTIVE' } });
  const newCutoff = new Date(Date.now() - 30 * 86_400_000);
  const expectedNew = await prisma.user.count({ where: { status: 'ACTIVE', createdAt: { gte: newCutoff } } });

  const allRes = await broadcastJob.handler({ kind: 'promotion', title: 'T', body: 'B', audience: 'all' });
  check('audience=all enqueues one push.send per active user', allRes.enqueued === totalActive, `got ${allRes.enqueued} vs ${totalActive}`);

  const newRes = await broadcastJob.handler({ kind: 'promotion', title: 'T', body: 'B', audience: 'new_users', newUserWithinDays: 30 });
  check('audience=new_users matches new-account count', newRes.enqueued === expectedNew, `got ${newRes.enqueued} vs ${expectedNew}`);
  check('new_users audience is a strict subset (old users excluded)', newRes.enqueued < allRes.enqueued);
  check('new test user IS within the new-user window', expectedNew >= 1);

  // ---------------------------------------------------------------------------
  // 5) Promo activation announce job (claim + idempotency + audience routing)
  // Asserts against the durable pg-boss job table (deterministic), not async
  // worker delivery, so it never races the queue drain.
  // ---------------------------------------------------------------------------
  console.log('\n[5] Promo activation announce');

  // Returns the enqueued push.broadcast job payload for a given promo code (any state).
  async function broadcastJobFor(code) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT data FROM pgboss.job WHERE name = 'push.broadcast' AND data->'data'->>'promoCode' = $1`,
      code
    );
    return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  }

  const codeAll = `${TAG}-ALL`.toUpperCase();
  const promoAll = await prisma.promoCode.create({
    data: {
      code: codeAll, name: 'E2E All', name_ar: 'E2E All',
      discountType: 'PERCENTAGE', discountValue: 20,
      startsAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 15 * 86_400_000),
      isActive: true, newUsersOnly: false, announcedAt: null,
    },
  });

  const codeNew = `${TAG}-NEW`.toUpperCase();
  const promoNew = await prisma.promoCode.create({
    data: {
      code: codeNew, name: 'E2E New', name_ar: 'E2E New',
      discountType: 'FIXED', discountValue: 10,
      startsAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 15 * 86_400_000),
      isActive: true, newUsersOnly: true, newUserWithinDays: 14, announcedAt: null,
    },
  });

  const r1 = await promoAnnounceJob.handler();
  check('announce job processed both due codes', r1.announced >= 2, `announced=${r1.announced}`);

  const afterAll = await prisma.promoCode.findUnique({ where: { id: promoAll.id } });
  const afterNew = await prisma.promoCode.findUnique({ where: { id: promoNew.id } });
  check('promo (all) stamped announcedAt', afterAll.announcedAt != null);
  check('promo (new) stamped announcedAt', afterNew.announcedAt != null);

  const allJobs = await broadcastJobFor(codeAll);
  const newJobs = await broadcastJobFor(codeNew);
  const bAll = allJobs[0];
  const bNew = newJobs[0];
  check('exactly one broadcast enqueued for the public code', allJobs.length === 1, `count=${allJobs.length}`);
  check('public code targets audience=all', bAll && bAll.audience === 'all');
  check('public code message names the code', bAll && bAll.body.includes(codeAll) && bAll.title.includes('E2E All'));
  check('exactly one broadcast enqueued for the new-user code', newJobs.length === 1, `count=${newJobs.length}`);
  check('new-user code targets audience=new_users', bNew && bNew.audience === 'new_users');
  check('new-user code carries its window', bNew && bNew.newUserWithinDays === 14);
  check('new-user code data carries promoCode for deep-link', bNew && bNew.data && bNew.data.promoCode === codeNew);

  // Idempotency: a second run must not enqueue any NEW broadcast for already-stamped codes.
  const r2 = await promoAnnounceJob.handler();
  const allJobs2 = await broadcastJobFor(codeAll);
  const newJobs2 = await broadcastJobFor(codeNew);
  check('second run does not re-announce (idempotent)',
    allJobs2.length === 1 && newJobs2.length === 1,
    `all=${allJobs2.length} new=${newJobs2.length} announced=${r2.announced}`);

  // ---------------------------------------------------------------------------
  // 6) Admin "new order" alert (staff fan-out, operational, buyer excluded)
  // ---------------------------------------------------------------------------
  console.log('\n[6] Admin new-order alert');

  async function pushSendJobsFor(orderId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT data FROM pgboss.job WHERE name = 'push.send' AND data->'data'->>'orderId' = $1`,
      orderId
    );
    return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  }

  const staffAdmin = await makeUser({ role: 'ADMIN' });
  const staffManager = await makeUser({ role: 'MANAGER' });
  const adminBuyer = await makeUser({ role: 'ADMIN' }); // an admin who is the buyer — must be excluded

  const fakeOrderId = `order-${TAG}`;
  const alertRes = await adminOrderAlertJob.handler({ orderId: fakeOrderId, totalAmount: 199, buyerId: adminBuyer.id });
  check('admin alert enqueued for staff', alertRes.enqueued >= 2, `enqueued=${alertRes.enqueued}`);

  const sendJobs = await pushSendJobsFor(fakeOrderId);
  const recipientIds = sendJobs.map((j) => j.userId);
  check('alert reached the admin', recipientIds.includes(staffAdmin.id));
  check('alert reached the manager', recipientIds.includes(staffManager.id));
  check('buyer (admin) was excluded', !recipientIds.includes(adminBuyer.id));
  const sample = sendJobs[0];
  check('alert is operational (prefKey null — bypasses prefs)', sample && sample.prefKey === null);
  check('alert type is ORDER_PLACED', sample && sample.type === 'ORDER_PLACED' && sample.data.type === 'ORDER_PLACED');
  check('alert data carries orderId + PENDING status', sample && sample.data.orderId === fakeOrderId && sample.data.status === 'PENDING');
  check('alert title/body are staff-facing', sample && sample.title === 'New Order' && sample.body.includes('199 AED'));

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
}

async function cleanup() {
  try {
    await prisma.promoCode.deleteMany({ where: { code: { startsWith: TAG.toUpperCase() } } });
    // Deleting users cascades to prefs / notifications / push devices.
    await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
    // Drop any still-queued jobs this run produced so they can't error against deleted test users.
    await prisma.$executeRawUnsafe(
      "DELETE FROM pgboss.job WHERE name IN ('push.send','push.broadcast','order.admin-alert') AND state IN ('created','active','retry')"
    );
  } catch (e) {
    console.error('[cleanup] error:', e.message);
  }
  await queue.stop().catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

run()
  .catch((e) => { failed += 1; console.error('\nFATAL:', e); })
  .finally(async () => {
    await cleanup();
    process.exit(failed === 0 ? 0 : 1);
  });
