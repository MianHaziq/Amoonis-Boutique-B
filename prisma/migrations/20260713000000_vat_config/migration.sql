-- Store-wide VAT: a single VatConfig row (rate + inclusive + scope), scoped to ALL products,
-- specific categories, or specific products, plus per-order and per-line VAT snapshots.

-- Scope selector (mirrors PromoAppliesTo).
CREATE TYPE "VatAppliesTo" AS ENUM ('ALL_PRODUCTS', 'SPECIFIC_PRODUCTS', 'SPECIFIC_CATEGORIES');

-- Singleton VAT config.
CREATE TABLE "VatConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ratePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "inclusive" BOOLEAN NOT NULL DEFAULT false,
    "appliesTo" "VatAppliesTo" NOT NULL DEFAULT 'ALL_PRODUCTS',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VatConfig_pkey" PRIMARY KEY ("id")
);

-- Scope join tables.
CREATE TABLE "VatConfigProduct" (
    "vatConfigId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VatConfigProduct_pkey" PRIMARY KEY ("vatConfigId", "productId")
);
CREATE INDEX "VatConfigProduct_productId_idx" ON "VatConfigProduct"("productId");

CREATE TABLE "VatConfigCategory" (
    "vatConfigId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VatConfigCategory_pkey" PRIMARY KEY ("vatConfigId", "categoryId")
);
CREATE INDEX "VatConfigCategory_categoryId_idx" ON "VatConfigCategory"("categoryId");

-- FKs.
ALTER TABLE "VatConfigProduct"
    ADD CONSTRAINT "VatConfigProduct_vatConfigId_fkey" FOREIGN KEY ("vatConfigId") REFERENCES "VatConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "VatConfigProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VatConfigCategory"
    ADD CONSTRAINT "VatConfigCategory_vatConfigId_fkey" FOREIGN KEY ("vatConfigId") REFERENCES "VatConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "VatConfigCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the singleton config row (disabled by default → no behaviour change until an admin turns it on).
INSERT INTO "VatConfig" ("id", "enabled", "ratePercent", "inclusive", "appliesTo", "updatedAt")
VALUES ('default', false, 0, false, 'ALL_PRODUCTS', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Order-level VAT snapshot. taxAmount already exists (reserved placeholder); add the rest.
ALTER TABLE "Order" ADD COLUMN "subtotalAmount" DECIMAL(10,2);
ALTER TABLE "Order" ADD COLUMN "vatRatePercent" DECIMAL(5,2);
ALTER TABLE "Order" ADD COLUMN "vatInclusive" BOOLEAN NOT NULL DEFAULT false;

-- Per-line VAT snapshot.
ALTER TABLE "OrderItem" ADD COLUMN "vatRatePercent" DECIMAL(5,2);
ALTER TABLE "OrderItem" ADD COLUMN "vatAmount" DECIMAL(10,2);
