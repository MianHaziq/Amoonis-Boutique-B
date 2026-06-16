/**
 * push.broadcast — fan a promotion/announcement out to many users.
 *
 * Data: { kind: 'promotion'|'announcement', title, body, data?, regionId? }
 *
 * Rather than blasting FCM here, we enqueue one push.send job per active user. Each
 * is then independently retryable, preference-gated and written to that user's inbox.
 * Users are paged by id cursor so memory stays flat regardless of user count.
 */

const prisma = require('../../config/db');
const { enqueue } = require('../queue');
const { QUEUES } = require('../queues');

async function handle(data) {
  const { kind = 'announcement', title, body, data: payload = {}, regionId } = data;
  if (!title || !body) {
    console.warn('[jobs] push.broadcast skipped — missing title/body');
    return { enqueued: 0 };
  }

  const prefKey = kind === 'promotion' ? 'promotions' : 'announcements';
  const type = kind === 'promotion' ? 'PROMOTION' : 'ANNOUNCEMENT';
  const where = { status: 'ACTIVE', ...(regionId ? { regionId } : {}) };

  const pageSize = 500;
  let cursor = null;
  let enqueued = 0;

  for (;;) {
    const users = await prisma.user.findMany({
      where,
      select: { id: true },
      take: pageSize,
      orderBy: { id: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (users.length === 0) break;

    for (const u of users) {
      await enqueue(
        QUEUES.PUSH_SEND,
        { userId: u.id, prefKey, type, title, body, data: { type, ...payload } },
        { allowInlineFallback: false }
      );
      enqueued += 1;
    }

    if (users.length < pageSize) break;
    cursor = users[users.length - 1].id;
  }

  console.log(`[jobs] push.broadcast kind=${kind} enqueued=${enqueued}`);
  return { enqueued };
}

module.exports = {
  queue: QUEUES.PUSH_BROADCAST,
  handler: handle,
  // No retry: a mid-run failure would restart the fan-out from the first user and
  // re-enqueue duplicate pushes for everyone already processed. Individual push.send
  // jobs have their own retries, so a partial broadcast loses at most a few users.
  options: { retryLimit: 0 },
};
