-- Zone-level catalog visibility for products and categories.
--
-- These join tables already existed to carry per-zone lead-time / cash-arrangement
-- overrides, where an ABSENT row means "inherit". Visibility therefore cannot be
-- expressed by row presence (the way ProductRegion/CategoryRegion do it) — with zero
-- rows today that would hide the entire catalog in every zone. It is an explicit
-- opt-out flag instead, defaulting to false so every existing row is unaffected.
ALTER TABLE "ProductZone"  ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CategoryZone" ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false;

-- Visibility queries filter by (zoneId, hidden) to exclude hidden content for the
-- resolved zone, so index that pair on both tables.
CREATE INDEX IF NOT EXISTS "ProductZone_zoneId_hidden_idx"  ON "ProductZone"  ("zoneId", "hidden");
CREATE INDEX IF NOT EXISTS "CategoryZone_zoneId_hidden_idx" ON "CategoryZone" ("zoneId", "hidden");
