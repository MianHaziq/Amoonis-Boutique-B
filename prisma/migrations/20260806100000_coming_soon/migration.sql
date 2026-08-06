-- AlterTable
-- "Coming soon" teaser flag on products and categories. Orthogonal to status:
-- coming-soon items are PUBLISHED (still visible) but cannot be ordered (enforced in
-- cart/order services). Default false = every existing row behaves exactly as before.
ALTER TABLE "Category" ADD COLUMN     "comingSoon" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN     "comingSoon" BOOLEAN NOT NULL DEFAULT false;
