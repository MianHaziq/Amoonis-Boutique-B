-- Renames ProductVariant's short blurb from "contents" to "subtitle" — it's
-- functionally a per-variant subtitle (shown under the product title in place of
-- Product.subtitle when the variant is active), not a list of box contents.

ALTER TABLE "ProductVariant" RENAME COLUMN "contents" TO "subtitle";
ALTER TABLE "ProductVariant" RENAME COLUMN "contents_ar" TO "subtitle_ar";
