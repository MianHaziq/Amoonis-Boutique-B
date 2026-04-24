-- Allow OrderItem to outlive its Product so a product can be removed from the catalog
-- without destroying historical orders (SHIPPED/DELIVERED/CANCELLED). Active orders
-- (PENDING/CONFIRMED/PROCESSING) are blocked at the application layer.

-- Drop the RESTRICT FK and recreate as SET NULL
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";

ALTER TABLE "OrderItem" ALTER COLUMN "productId" DROP NOT NULL;

ALTER TABLE "OrderItem" ADD COLUMN "productTitle" TEXT;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
