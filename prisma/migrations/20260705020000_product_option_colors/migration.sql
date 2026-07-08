-- ============================================================================
-- Per-value swatch colours (ProductOption.optionColors)
--
-- Lets admins pick an exact swatch colour per option value (e.g. a custom
-- "dark pink" #c2185b) instead of relying on the name→colour guess. Aligned by
-- index with `options`, same as `optionImages`.
--
-- Additive and safe: NOT NULL DEFAULT '{}' backfills every existing row to an
-- empty array, and the mobile app (which doesn't read this column) is
-- unaffected.
-- ============================================================================

-- AlterTable
ALTER TABLE "ProductOption" ADD COLUMN IF NOT EXISTS "optionColors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
