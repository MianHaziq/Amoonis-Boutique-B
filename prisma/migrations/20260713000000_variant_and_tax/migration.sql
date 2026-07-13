-- Variant capture (CartItem/OrderItem) + reserved tax column (Order), for the
-- Order Export / Analytics Export feature.

ALTER TABLE "CartItem" ADD COLUMN "selectedOptions" JSONB;
ALTER TABLE "OrderItem" ADD COLUMN "selectedOptions" JSONB;
ALTER TABLE "Order" ADD COLUMN "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
