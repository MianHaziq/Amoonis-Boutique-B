-- Per-region delivery lead time: the same product/category can now ship within a
-- different number of days in different regions (e.g. a category is 1-day in UAE
-- but 2-day in KSA). Overrides the product/category global lead time in that
-- region only. Nullable → no override falls through the existing global chain,
-- so behaviour is unchanged until an admin sets a per-region value.

-- AlterTable
ALTER TABLE "ProductRegion" ADD COLUMN "deliveryLeadDays" INTEGER;

-- AlterTable
ALTER TABLE "CategoryRegion" ADD COLUMN "deliveryLeadDays" INTEGER;
