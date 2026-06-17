/**
 * push.broadcast — fan a promotion/announcement out to many users.
 *
 * Data: {
 *   kind: 'promotion'|'announcement', title, body, data?, regionId?,
 *   audience?: 'all'|'new_users',   // default 'all'
 *   newUserWithinDays?: number,     // account-age window when audience === 'new_users'
 * }
 *
 * Rather than blasting FCM here, we enqueue one push.send job per active user. Each
 * is then independently retryable, preference-gated and written to that user's inbox.
 * Users are paged by id cursor so memory stays flat regardless of user count.
 */

const prisma = require('../../config/db');
const { enqueueMany } = require('../queue');
const { QUEUES } = require('../queues');

// How many push.send jobs to write per pg-boss batch insert.
const ENQUEUE_BATCH_SIZE = 200;

// Fallback account-age window (days) for a 'new_users' broadcast with no explicit window.
const NEW_USER_DEFAULT_WINDOW_DAYS = 30;

async function handle(data) {
  const { kind = 'announcement', title, body, data: payload = {}, regionId, audience = 'all', newUserWithinDays } = data;
  if (!title || !body) {
    console.warn('[jobs] push.broadcast skipped — missing title/body');
    return { enqueued: 0 };
  }

  const prefKey = kind === 'promotion' ? 'promotions' : 'announcements';
  const type = kind === 'promotion' ? 'PROMOTION' : 'ANNOUNCEMENT';
  const where = { status: 'ACTIVE', ...(regionId ? { regionId } : {}) };

  // 'new_users' audience: restrict to accounts created within the eligibility window,
  // so a new-user-only promo is only announced to users who can actually redeem it.
  if (audience === 'new_users') {
    const days = Number.isFinite(Number(newUserWithinDays)) && Number(newUserWithinDays) > 0
      ? Number(newUserWithinDays)
      : NEW_USER_DEFAULT_WINDOW_DAYS;
    where.createdAt = { gte: new Date(Date.now() - days * 86_400_000) };
  }

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

    // Batch the per-user push.send jobs into a few multi-row inserts rather than one
    // serial enqueue (one DB insert) per user. The data enqueued per user is
    // unchanged; we only change how it's written.
    for (let i = 0; i < users.length; i += ENQUEUE_BATCH_SIZE) {
      const slice = users.slice(i, i + ENQUEUE_BATCH_SIZE);
      const jobs = slice.map((u) => ({
        data: { userId: u.id, prefKey, type, title, body, data: { type, ...payload } },
      }));
      enqueued += await enqueueMany(QUEUES.PUSH_SEND, jobs, { allowInlineFallback: false });
    }

    if (users.length < pageSize) break;
    cursor = users[users.length - 1].id;
  }

  console.log(`[jobs] push.broadcast kind=${kind} audience=${audience} enqueued=${enqueued}`);
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
