-- ============================================================================
-- Per-value image SETS (ProductOption.optionImageSets)
--
-- A JSON array-of-arrays aligned by index with `options`, letting a value (e.g.
-- a colour) carry several photos. The first photo of each set is mirrored into
-- the existing `optionImages` column, which the mobile app keeps reading — so
-- this column is purely additive and the mobile client is unaffected.
--
-- Nullable (no default) — absence means "no multi-image sets", and consumers
-- fall back to the single `optionImages` value.
-- ============================================================================

-- AlterTable
ALTER TABLE "ProductOption" ADD COLUMN IF NOT EXISTS "optionImageSets" JSONB;
