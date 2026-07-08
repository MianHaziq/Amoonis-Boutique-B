-- ============================================================================
-- Order currency snapshot (Order.currency)
--
-- Nullable: legacy orders placed before multi-currency have no value (treat as
-- the store default, AED, in reporting/UI). New orders stamp the placing
-- region's currency at creation time (see order.service.js createOrderCore).
-- ============================================================================

-- AlterTable
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "currency" TEXT;
