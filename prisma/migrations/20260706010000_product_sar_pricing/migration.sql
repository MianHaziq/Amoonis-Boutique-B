-- ============================================================================
-- Manual SAR price override (Product.priceSar / discountedPriceSar)
--
-- Nullable, additive: a product with no SAR price set falls back to the AED
-- price/discountedPrice for a Saudi-region request. The mobile app (which
-- doesn't read these columns) is unaffected.
-- ============================================================================

-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "priceSar" DECIMAL(10,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "discountedPriceSar" DECIMAL(10,2);
