-- New-user-only promo codes (account-age based).
-- Adds two nullable/defaulted columns so the migration is safe on a live, populated
-- database: existing rows get newUsersOnly = false and newUserWithinDays = NULL.

ALTER TABLE "PromoCode"
  ADD COLUMN IF NOT EXISTS "newUsersOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PromoCode"
  ADD COLUMN IF NOT EXISTS "newUserWithinDays" INTEGER;

-- The window, when present, must be a positive number of days. Added NOT VALID so legacy
-- rows are never re-checked; enforced for every new INSERT/UPDATE.
ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_newUserWithinDays_positive_check"
  CHECK ("newUserWithinDays" IS NULL OR "newUserWithinDays" >= 1) NOT VALID;
