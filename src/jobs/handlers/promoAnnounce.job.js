/**
 * promo.announce-active — notify users when a promo code becomes active.
 *
 * Admins create a code with a start date (e.g. "active from the 1st"). This daily job
 * finds codes that have reached their start date but haven't been announced yet and
 * fans a promotion broadcast out to users (push + in-app inbox, gated by each user's
 * `promotions` preference):
 *   - normal codes        → announced to ALL active users
 *   - newUsersOnly codes  → announced ONLY to eligible new users (account age within
 *                           the code's newUserWithinDays window)
 *
 * Idempotency: a code is "claimed" with an updateMany guarded on announcedAt IS NULL
 * BEFORE its broadcast is enqueued, so two overlapping runs (or a retry) can never
 * announce the same code twice. Pre-existing codes were backfilled with announcedAt in
 * the migration, so the feature never retroactively blasts old codes.
 */

const prisma = require('../../config/db');
const { enqueue } = require('../queue');
const { QUEUES } = require('../queues');

// Cap codes processed per run — a runaway backlog (or a clock jump) can't fan out an
// unbounded number of broadcasts in a single tick.
const MAX_PER_RUN = Math.max(1, parseInt(process.env.PROMO_ANNOUNCE_MAX_PER_RUN || '20', 10));

function formatDiscount(promo, lang) {
  const value = Number(promo.discountValue);
  if (promo.discountType === 'PERCENTAGE') {
    const pct = Number.isInteger(value) ? String(value) : value.toFixed(0);
    return lang === 'ar' ? `خصم ${pct}%` : `${pct}% off`;
  }
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return lang === 'ar' ? `خصم ${amount} درهم` : `${amount} AED off`;
}

function formatDate(d) {
  // YYYY-MM-DD in UTC — locale-agnostic and unambiguous for a notification line.
  return new Date(d).toISOString().slice(0, 10);
}

// Build bilingual broadcast copy from the promo. push.job picks en/ar per recipient's
// preferredLanguage, so an Arabic customer reads the Arabic line. The Arabic name falls
// back to the English name when name_ar isn't set.
function buildLocalized(promo) {
  const date = promo.expiresAt ? formatDate(promo.expiresAt) : null;
  const nameAr = promo.name_ar || promo.name;
  return {
    en: {
      title: `New offer: ${promo.name}`,
      body: `Use code ${promo.code} for ${formatDiscount(promo, 'en')}.` + (date ? ` Valid until ${date}.` : ''),
    },
    ar: {
      title: `عرض جديد: ${nameAr}`,
      body: `استخدم الرمز ${promo.code} للحصول على ${formatDiscount(promo, 'ar')}.` + (date ? ` ساري حتى ${date}.` : ''),
    },
  };
}

async function handle() {
  const now = new Date();

  const due = await prisma.promoCode.findMany({
    where: {
      isActive: true,
      announcedAt: null,
      announceToUsers: true, // silent (internal/staff) codes are never broadcast
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: { startsAt: 'asc' },
    take: MAX_PER_RUN,
  });

  let announced = 0;
  for (const promo of due) {
    // Claim the code first so a concurrent run / retry can't double-announce it.
    const claim = await prisma.promoCode.updateMany({
      where: { id: promo.id, announcedAt: null },
      data: { announcedAt: now },
    });
    if (claim.count !== 1) continue; // someone else already claimed it

    try {
      const jobId = await enqueue(QUEUES.PUSH_BROADCAST, {
        kind: 'promotion',
        localized: buildLocalized(promo),
        audience: promo.newUsersOnly ? 'new_users' : 'all',
        newUserWithinDays: promo.newUserWithinDays ?? null,
        data: { type: 'PROMOTION', promoCode: promo.code, promoCodeId: promo.id },
      }, { allowInlineFallback: false });
      // enqueue returns null (without throwing) if the engine couldn't queue the job.
      // Treat that as a failure so the claim is rolled back and the code is retried next
      // run — otherwise it would stay stamped "announced" with nobody ever notified.
      if (!jobId) throw new Error('broadcast enqueue returned null (engine unavailable)');
      announced += 1;
    } catch (err) {
      // Roll the claim back so the next run retries this code rather than silently
      // dropping it (it was never broadcast).
      await prisma.promoCode
        .updateMany({ where: { id: promo.id, announcedAt: now }, data: { announcedAt: null } })
        .catch(() => {});
      console.error(`[jobs] promo.announce-active enqueue failed for ${promo.code}:`, err.message);
    }
  }

  if (announced > 0) console.log(`[jobs] promo.announce-active announced=${announced}`);
  return { announced };
}

module.exports = {
  queue: QUEUES.PROMO_ANNOUNCE,
  handler: handle,
  // Daily, just after midnight UTC, so a code with a 1st-of-month start is announced
  // on the 1st. Override with PROMO_ANNOUNCE_CRON.
  cron: process.env.PROMO_ANNOUNCE_CRON || '15 0 * * *',
  options: { retryLimit: 0 },
};
