-- ============================================================================
-- Per-value option images (ProductOption.optionImages)
--
-- Optional image URLs aligned by index with `options` (e.g. a "Colour" option
-- maps Blue/Pink/White to specific product photos). Purely additive and empty by
-- default, so existing API consumers (the Flutter mobile app) are unaffected.
--
-- IF NOT EXISTS: this column was originally added out-of-band via raw SQL on the
-- active database, so it may already exist. Making the ALTER idempotent lets
-- `prisma migrate deploy` run cleanly whether or not the column is already present
-- (fresh prod DB -> created; already-patched DB -> no-op).
-- ============================================================================

-- AlterTable
ALTER TABLE "ProductOption" ADD COLUMN IF NOT EXISTS "optionImages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
