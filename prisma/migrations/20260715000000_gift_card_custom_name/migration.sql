-- ============================================================================
-- Gift card + custom name product add-ons
--
-- Mirrors the client site's "Include a gift card?" (free, per-product toggle)
-- and "Add Custom Name (+price)?" (paid, per-product toggle + price) options.
-- All new columns default to disabled/null so existing rows are unaffected
-- until the backfill script or an admin explicitly turns them on.
-- ============================================================================

-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "giftCardEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "giftCardExtraPrice" DECIMAL(10,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "customNameEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "customNamePrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "giftCardSelected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "customName" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "giftCardSelected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "customName" TEXT;
