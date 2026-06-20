-- 1) Human-friendly sequential order numbers (Shopify-style, starting at 1001).
--    Backed by a dedicated sequence so inserts get a gap-free-ish, readable number that
--    is not the raw UUID. Safe on a populated table: existing orders are backfilled in
--    chronological order, then the sequence is advanced past the highest assigned number.

CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1001;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "orderNumber" INTEGER;

-- Backfill existing rows in creation order (1001, 1002, ...). Uses a deterministic
-- base + row_number so the assignment is chronological (nextval ordering across an
-- UPDATE ... FROM is not guaranteed, so we compute the value explicitly).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "Order"
  WHERE "orderNumber" IS NULL
)
UPDATE "Order" o
SET "orderNumber" = 1000 + ordered.rn
FROM ordered
WHERE o.id = ordered.id;

-- Advance the sequence past the highest backfilled value so new inserts never collide.
SELECT setval('order_number_seq', (SELECT COALESCE(MAX("orderNumber"), 1000) FROM "Order"));

-- Now make it DB-assigned, required, unique, and tie the sequence's lifetime to the column.
ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET DEFAULT nextval('order_number_seq');
ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET NOT NULL;
ALTER SEQUENCE order_number_seq OWNED BY "Order"."orderNumber";
CREATE UNIQUE INDEX IF NOT EXISTS "Order_orderNumber_key" ON "Order"("orderNumber");

-- 2) Per-code opt-out for the "promo is now active" broadcast. Internal/staff codes can be
--    created silent. Default true so normal promos keep auto-announcing.
ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "announceToUsers" BOOLEAN NOT NULL DEFAULT true;
