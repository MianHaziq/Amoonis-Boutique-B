-- Replace OrderStatus with the client-requested WooCommerce-style status set.
-- Several old values collapse into one new value (CONFIRMED/PROCESSING/SHIPPED ->
-- PROCESSING; AWAITING_PAYMENT/PENDING -> PENDING_PAYMENT; DELIVERED -> COMPLETED),
-- which Postgres enums can't express as a simple rename/add — the column is swapped
-- to a new enum type via an explicit USING mapping, then the old type is dropped.
-- The CASE has no ELSE: an unmapped value would hit the NOT NULL constraint and fail
-- the migration loudly rather than silently mis-bucketing an order.

BEGIN;

CREATE TYPE "OrderStatus_new" AS ENUM (
  'PENDING_PAYMENT',
  'PROCESSING',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'FAILED',
  'DRAFT'
);

ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Order"
  ALTER COLUMN "status" TYPE "OrderStatus_new"
  USING (
    CASE "status"::text
      WHEN 'AWAITING_PAYMENT' THEN 'PENDING_PAYMENT'
      WHEN 'PENDING' THEN 'PENDING_PAYMENT'
      WHEN 'CONFIRMED' THEN 'PROCESSING'
      WHEN 'PROCESSING' THEN 'PROCESSING'
      WHEN 'SHIPPED' THEN 'PROCESSING'
      WHEN 'DELIVERED' THEN 'COMPLETED'
      WHEN 'CANCELLED' THEN 'CANCELLED'
    END
  )::"OrderStatus_new";

ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';

DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";

COMMIT;
