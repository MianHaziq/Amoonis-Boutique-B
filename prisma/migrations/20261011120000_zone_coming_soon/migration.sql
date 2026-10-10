-- Per-zone "coming soon" teaser for products and categories, one tier below the
-- existing per-region flag (ProductRegion/CategoryRegion.comingSoon).
--
-- Additive and defaulted false, so every existing row keeps its current meaning: a zone
-- can only ADD a teaser, never clear one set globally or per-region.
ALTER TABLE "ProductZone"  ADD COLUMN IF NOT EXISTS "comingSoon" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CategoryZone" ADD COLUMN IF NOT EXISTS "comingSoon" BOOLEAN NOT NULL DEFAULT false;
