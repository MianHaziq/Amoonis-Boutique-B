-- Guest checkout: allow orders (and promo usage) without an authenticated user.

-- Order.userId becomes nullable; add the guest contact snapshot + a lookup index
-- on guestEmail (the account-linking key).
ALTER TABLE "Order" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Order" ADD COLUMN "guestName" TEXT;
ALTER TABLE "Order" ADD COLUMN "guestPhone" TEXT;
ALTER TABLE "Order" ADD COLUMN "guestEmail" TEXT;
CREATE INDEX "Order_guestEmail_idx" ON "Order"("guestEmail");

-- PromoCodeUsage.userId becomes nullable so a promo can be redeemed on a guest order.
ALTER TABLE "PromoCodeUsage" ALTER COLUMN "userId" DROP NOT NULL;
