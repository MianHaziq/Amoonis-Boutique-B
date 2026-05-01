-- AlterTable Category
ALTER TABLE "Category" ADD COLUMN "title_ar" TEXT, ADD COLUMN "description_ar" TEXT;

-- AlterTable Product
ALTER TABLE "Product" ADD COLUMN "title_ar" TEXT, ADD COLUMN "subtitle_ar" TEXT;

-- AlterTable ProductDescription
ALTER TABLE "ProductDescription" ADD COLUMN "title_ar" TEXT, ADD COLUMN "description_ar" TEXT;

-- AlterTable ProductOption
ALTER TABLE "ProductOption" ADD COLUMN "title_ar" TEXT, ADD COLUMN "options_ar" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable Section
ALTER TABLE "Section" ADD COLUMN "title_ar" TEXT;

-- AlterTable PromoCode
ALTER TABLE "PromoCode" ADD COLUMN "name_ar" TEXT, ADD COLUMN "description_ar" TEXT;

-- AlterTable OrderItem
ALTER TABLE "OrderItem" ADD COLUMN "productTitle_ar" TEXT;
