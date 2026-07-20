-- AlterTable: new Settings rows default to AED (this is an AED-priced GCC store, not USD)
ALTER TABLE "Settings" ALTER COLUMN "currency" SET DEFAULT 'AED';

-- Data fix: the existing row is still sitting on the old schema default of
-- 'USD' (never intentionally set) — that's what makes the admin dashboard's
-- "all regions" analytics view and every export show USD. Only touches rows
-- still on the untouched default, so an admin who deliberately chose USD
-- keeps their choice.
UPDATE "Settings" SET currency = 'AED' WHERE currency = 'USD';
