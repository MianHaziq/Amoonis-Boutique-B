-- AlterTable (idempotent): flag for whether placing this order clears the user's cart.
-- Defaults true (normal cart checkout); "Buy Now" single-product orders set it false.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "clearCartOnPayment" BOOLEAN NOT NULL DEFAULT true;
