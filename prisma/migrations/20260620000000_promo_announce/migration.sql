-- Promo activation announcements.
-- Adds an idempotency marker for the daily "this promo is now active" broadcast so a
-- code is announced to users exactly once (on/after its start date).

ALTER TABLE "PromoCode"
  ADD COLUMN IF NOT EXISTS "announcedAt" TIMESTAMP(3);

-- Backfill: every promo code that already exists when this deploys is treated as
-- already-announced, so turning the feature on does NOT retroactively blast users
-- about pre-existing codes. Only codes created from here on can be announced.
UPDATE "PromoCode"
  SET "announcedAt" = now()
  WHERE "announcedAt" IS NULL;
