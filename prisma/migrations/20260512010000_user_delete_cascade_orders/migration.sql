-- Allow admin to delete a user even when they have orders.
-- Was ON DELETE RESTRICT, which blocked the deletion. OrderItem.orderId
-- already cascades from Order, so removing the parent Order cleans up items
-- automatically.

ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
