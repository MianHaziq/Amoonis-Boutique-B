-- Variant-aware cart: a line is now identified by (cart, product, variant) so
-- the same product in different colours/sizes is separate lines (Amazon/Shopify
-- style) instead of one line whose variant gets overwritten on re-add.

-- AlterTable: new normalized variant discriminator (""=no variant, matches legacy rows).
ALTER TABLE "CartItem" ADD COLUMN "variantKey" TEXT NOT NULL DEFAULT '';

-- Swap the uniqueness key from (cartId, productId) to (cartId, productId, variantKey).
-- Existing rows all have variantKey='' and were already unique per (cartId, productId),
-- so no row collides under the new key — the change is safe with no data cleanup.
DROP INDEX "CartItem_cartId_productId_key";
CREATE UNIQUE INDEX "CartItem_cartId_productId_variantKey_key" ON "CartItem"("cartId", "productId", "variantKey");
