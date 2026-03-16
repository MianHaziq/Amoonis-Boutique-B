-- CreateTable ProductImage for multiple ordered images per product
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");
CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing single image to ProductImage (sortOrder 0)
INSERT INTO "ProductImage" ("id", "productId", "url", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, "id", "image", 0, "createdAt"
FROM "Product"
WHERE "image" IS NOT NULL AND "image" != '';

-- Drop old image column
ALTER TABLE "Product" DROP COLUMN IF EXISTS "image";
