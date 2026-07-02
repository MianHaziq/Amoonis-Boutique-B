/**
 * Verification harness for the notification inbox (notification.service) — the
 * module powering the web notification bell + /account/notifications. Covers
 * list + unread count, mark-one/mark-all read, idempotent re-read, per-user
 * isolation (can't read someone else's), unknown id, and unreadOnly + paging.
 *
 * LOCAL throwaway DB only:
 *   DATABASE_URL="postgresql://postgres@localhost:5432/amoonis_search_test" \
 *     node scripts/notifications-verify.js
 */
const prisma = require('../src/config/db');
const svc = require('../src/services/notification.service');

const TAG = 'ZZNOTIFTEST';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function cleanup() {
  await prisma.notification.deleteMany({ where: { user: { email: { contains: TAG } } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
}

async function main() {
  await cleanup();

  const a = await prisma.user.create({ data: { email: `${TAG}_a@test.local` } });
  const b = await prisma.user.create({ data: { email: `${TAG}_b@test.local` } });

  // Seed 3 for A, 1 for B.
  await svc.create({ userId: a.id, type: 'ORDER', title: 'Order placed', body: 'We received your order.' });
  await svc.create({ userId: a.id, type: 'ORDER', title: 'Order confirmed', body: 'Your order is confirmed.' });
  await svc.create({ userId: a.id, type: 'PROMO', title: 'Weekend offer', body: '20% off bouquets.', data: { deeplink: '/shop' } });
  await svc.create({ userId: b.id, type: 'ORDER', title: 'B only', body: 'For user B.' });

  // 1. list + unread
  let list = await svc.list(a.id, {});
  ok('list returns all of the user\'s notifications', list.total === 3, `got ${list.total}`);
  ok('list unreadCount = 3', list.unreadCount === 3, `got ${list.unreadCount}`);
  ok('newest first', list.data[0].title === 'Weekend offer', list.data[0]?.title);
  ok('payload/deeplink preserved', list.data[0].data?.deeplink === '/shop');

  // 2. unreadCount endpoint
  ok('unreadCount() = 3', (await svc.unreadCount(a.id)) === 3);

  // 3. mark one read (idempotent)
  const target = list.data[2].id; // oldest
  let n = await svc.markRead(a.id, target);
  ok('markRead marks exactly one', n === 1, `got ${n}`);
  ok('unread drops to 2', (await svc.unreadCount(a.id)) === 2);
  n = await svc.markRead(a.id, target);
  ok('re-reading an already-read one affects 0 rows', n === 0, `got ${n}`);

  // 4. cross-user isolation — B cannot read A's notification
  n = await svc.markRead(b.id, list.data[0].id);
  ok('a user cannot mark another user\'s notification read', n === 0, `got ${n}`);
  ok('A\'s unread unchanged after B\'s attempt', (await svc.unreadCount(a.id)) === 2);

  // 5. unknown id
  n = await svc.markRead(a.id, '00000000-0000-0000-0000-000000000000');
  ok('marking an unknown id affects 0 rows', n === 0);

  // 6. unreadOnly filter
  const unreadList = await svc.list(a.id, { unreadOnly: true });
  ok('unreadOnly returns only unread', unreadList.total === 2 && unreadList.data.every((x) => x.readAt === null));

  // 7. mark all read
  const updated = await svc.markAllRead(a.id);
  ok('markAllRead clears the remaining unread', updated === 2, `got ${updated}`);
  ok('unread is now 0', (await svc.unreadCount(a.id)) === 0);
  ok('markAllRead again is a no-op', (await svc.markAllRead(a.id)) === 0);

  // 8. user isolation on list — B still has exactly its own 1
  const listB = await svc.list(b.id, {});
  ok('user B sees only its own 1 notification', listB.total === 1 && listB.data[0].title === 'B only');

  // 9. pagination
  for (let i = 0; i < 25; i++) {
    await svc.create({ userId: b.id, type: 'PROMO', title: `bulk ${i}`, body: 'x' });
  }
  const page1 = await svc.list(b.id, { page: 1, limit: 10 });
  ok('pagination caps page size', page1.data.length === 10 && page1.total === 26 && page1.totalPages === 3,
    JSON.stringify({ len: page1.data.length, total: page1.total, pages: page1.totalPages }));

  await cleanup();
  console.log(`\n${failures === 0 ? '🎉 ALL PASSED' : `💥 ${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch {}
  await prisma.$disconnect();
  process.exit(1);
});
