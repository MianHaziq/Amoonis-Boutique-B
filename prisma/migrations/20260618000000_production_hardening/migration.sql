-- Production hardening migration.
-- Safe to apply to a live, populated database via `prisma migrate deploy`:
--   * existing-data violations are de-duplicated before adding the partial unique index;
--   * money/promo CHECK constraints are added NOT VALID so legacy rows are never re-validated
--     (the constraints are still enforced for all new INSERT/UPDATE writes);
--   * the FK swap and index creation are idempotent where possible.

-- ============================================================
-- H11 — Enforce a single default Region.
-- ============================================================
-- Prisma cannot express a partial unique index, so this is raw SQL.
-- First de-duplicate: if more than one Region has isDefault = true, keep the
-- oldest one (earliest createdAt, id as tiebreaker) and clear the rest. This
-- guarantees the unique index below can be created on existing data.
UPDATE "Region"
SET "isDefault" = false
WHERE "isDefault" = true
  AND "id" <> (
    SELECT "id"
    FROM "Region"
    WHERE "isDefault" = true
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  );

-- At most one row may have isDefault = true.
CREATE UNIQUE INDEX IF NOT EXISTS "Region_single_default"
  ON "Region" ("isDefault")
  WHERE "isDefault" = TRUE;

-- ============================================================
-- M9 — Non-negative money / promo CHECK constraints.
-- ============================================================
-- Added NOT VALID: PostgreSQL skips validating existing rows (so the migration
-- cannot fail on legacy/test data) but enforces the constraint on every new
-- INSERT/UPDATE. A later `VALIDATE CONSTRAINT` can be run out-of-band once data
-- is known clean.

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_price_nonneg_check" CHECK ("price" >= 0) NOT VALID;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_quantity_nonneg_check" CHECK ("quantity" >= 0) NOT VALID;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_totalAmount_nonneg_check" CHECK ("totalAmount" >= 0) NOT VALID;

ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_discountValue_nonneg_check" CHECK ("discountValue" >= 0) NOT VALID;

-- Nullable columns: NULL passes the CHECK automatically, so only present values are bounded.
ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_minOrderAmount_nonneg_check"
  CHECK ("minOrderAmount" IS NULL OR "minOrderAmount" >= 0) NOT VALID;

ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_maxDiscountAmount_nonneg_check"
  CHECK ("maxDiscountAmount" IS NULL OR "maxDiscountAmount" >= 0) NOT VALID;

-- Percentage promos cannot exceed 100%. The discount-type column is "discountType"
-- (enum DiscountType); FIXED promos are unaffected by the upper bound.
ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_percentage_max_check"
  CHECK ("discountType" <> 'PERCENTAGE' OR "discountValue" <= 100) NOT VALID;

-- ============================================================
-- M10 — Product.categoryId: SET NULL -> RESTRICT.
-- ============================================================
-- Block deletion of a non-empty category instead of silently orphaning products.
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_categoryId_fkey";
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- M14 — Composite index for order history (userId, createdAt).
-- ============================================================
CREATE INDEX IF NOT EXISTS "Order_userId_createdAt_idx"
  ON "Order" ("userId", "createdAt");
