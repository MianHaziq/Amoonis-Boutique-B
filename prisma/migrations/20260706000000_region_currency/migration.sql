-- ============================================================================
-- Region currency (Region.currency)
--
-- Drives storefront price display, order currency snapshot, and which orders
-- are eligible for online payment. DEFAULT 'AED' backfills every existing
-- region so nothing changes on deploy; the Saudi (SA) row is then explicitly
-- set to SAR (its known currency) as a one-time data fix.
-- ============================================================================

-- AlterTable
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'AED';

-- DataMigration: Saudi Arabia charges/displays in SAR.
UPDATE "Region" SET "currency" = 'SAR' WHERE "code" = 'SA';
