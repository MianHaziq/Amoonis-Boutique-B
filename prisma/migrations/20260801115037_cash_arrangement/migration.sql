-- CreateEnum
CREATE TYPE "CashArrangementAppliesTo" AS ENUM ('ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES');

-- AlterEnum
ALTER TYPE "ManagerPermission" ADD VALUE 'CASH_ARRANGEMENT';

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "CategoryRegion" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "CategoryZone" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cashArrangementAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementDenomination" INTEGER,
ADD COLUMN     "cashArrangementFeeAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementFeeVatAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementNote" TEXT,
ADD COLUMN     "cashArrangementRequested" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "ProductRegion" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "ProductZone" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "CashArrangementConfig" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "appliesTo" "CashArrangementAppliesTo" NOT NULL DEFAULT 'ALL_PRODUCTS',
    "quickPickAmounts" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "denominations" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashArrangementConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashArrangementConfigProduct" (
    "cashArrangementConfigId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashArrangementConfigProduct_pkey" PRIMARY KEY ("cashArrangementConfigId","productId")
);

-- CreateTable
CREATE TABLE "CashArrangementConfigCategory" (
    "cashArrangementConfigId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashArrangementConfigCategory_pkey" PRIMARY KEY ("cashArrangementConfigId","categoryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashArrangementConfig_regionId_key" ON "CashArrangementConfig"("regionId");

-- CreateIndex
CREATE INDEX "CashArrangementConfigProduct_productId_idx" ON "CashArrangementConfigProduct"("productId");

-- CreateIndex
CREATE INDEX "CashArrangementConfigCategory_categoryId_idx" ON "CashArrangementConfigCategory"("categoryId");

-- AddForeignKey
ALTER TABLE "CashArrangementConfig" ADD CONSTRAINT "CashArrangementConfig_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashArrangementConfigProduct" ADD CONSTRAINT "CashArrangementConfigProduct_cashArrangementConfigId_fkey" FOREIGN KEY ("cashArrangementConfigId") REFERENCES "CashArrangementConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashArrangementConfigProduct" ADD CONSTRAINT "CashArrangementConfigProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashArrangementConfigCategory" ADD CONSTRAINT "CashArrangementConfigCategory_cashArrangementConfigId_fkey" FOREIGN KEY ("cashArrangementConfigId") REFERENCES "CashArrangementConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashArrangementConfigCategory" ADD CONSTRAINT "CashArrangementConfigCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
