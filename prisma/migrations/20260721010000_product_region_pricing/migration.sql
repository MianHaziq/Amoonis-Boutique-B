-- Replace the hardcoded single-currency Product.priceSar/discountedPriceSar
-- override with a generic per-region price override on ProductRegion, keyed
-- by regionId, so every region (not just Saudi Arabia) can have its own
-- manual price override.

-- 1. Add the new columns to the region join table.
ALTER TABLE "ProductRegion" ADD COLUMN IF NOT EXISTS "price" DECIMAL(10, 2);
ALTER TABLE "ProductRegion" ADD COLUMN IF NOT EXISTS "discountedPrice" DECIMAL(10, 2);

-- 2. Backfill existing Saudi Arabia overrides into the new column so nothing
-- regresses for products that already had a manual SAR price set.
UPDATE "ProductRegion" pr
SET "price" = p."priceSar",
    "discountedPrice" = p."discountedPriceSar"
FROM "Product" p, "Region" r
WHERE pr."productId" = p.id
  AND pr."regionId" = r.id
  AND r.code = 'SA'
  AND p."priceSar" IS NOT NULL;

-- 3. Drop the old hardcoded columns now that the data lives in ProductRegion.
ALTER TABLE "Product" DROP COLUMN IF EXISTS "priceSar";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "discountedPriceSar";
