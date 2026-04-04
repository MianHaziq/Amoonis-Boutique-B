-- Track whether order line quantities have been subtracted from Product.stock (inventory).

ALTER TABLE "Order" ADD COLUMN "inventoryDeducted" BOOLEAN NOT NULL DEFAULT false;
