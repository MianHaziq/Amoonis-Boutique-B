-- ============================================================================
-- Product display order (Product.sortOrder)
--
-- Adds an admin-controlled display order for products (drag-and-drop reorder in
-- the admin catalog). Additive and safe:
--   * NOT NULL DEFAULT 0 backfills every existing product to 0, so the effective
--     order is unchanged (list falls back to createdAt DESC) until an admin
--     reorders. The mobile app / storefront see no change on deploy.
--   * Composite index serves the ordered list query
--     (WHERE status = ? ORDER BY sortOrder ASC, createdAt DESC).
-- ============================================================================

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Product_status_sortOrder_idx" ON "Product"("status", "sortOrder");
