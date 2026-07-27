-- Per-delivery-zone prep-lead overrides for products and categories. Highest precedence
-- in the lead-time chain (zone -> region -> base), consulted at checkout/order time.

CREATE TABLE "ProductZone" (
    "productId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "deliveryLeadDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductZone_pkey" PRIMARY KEY ("productId","zoneId")
);
CREATE INDEX "ProductZone_zoneId_idx" ON "ProductZone"("zoneId");
ALTER TABLE "ProductZone" ADD CONSTRAINT "ProductZone_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductZone" ADD CONSTRAINT "ProductZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DeliveryZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CategoryZone" (
    "categoryId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "deliveryLeadDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategoryZone_pkey" PRIMARY KEY ("categoryId","zoneId")
);
CREATE INDEX "CategoryZone_zoneId_idx" ON "CategoryZone"("zoneId");
ALTER TABLE "CategoryZone" ADD CONSTRAINT "CategoryZone_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CategoryZone" ADD CONSTRAINT "CategoryZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DeliveryZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
