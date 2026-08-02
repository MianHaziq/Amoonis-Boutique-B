-- AlterTable
ALTER TABLE "ProductDescription" ADD COLUMN     "variantId" TEXT;

-- CreateIndex
CREATE INDEX "ProductDescription_variantId_idx" ON "ProductDescription"("variantId");

-- AddForeignKey
ALTER TABLE "ProductDescription" ADD CONSTRAINT "ProductDescription_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
