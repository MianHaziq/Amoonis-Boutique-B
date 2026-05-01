-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD');

-- CreateTable: saved addresses
CREATE TABLE "Address" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId"        TEXT NOT NULL,
    "label"         TEXT,
    "fullName"      TEXT NOT NULL,
    "phone"         TEXT NOT NULL,
    "streetAddress" TEXT NOT NULL,
    "apartment"     TEXT,
    "city"          TEXT NOT NULL,
    "state"         TEXT,
    "postalCode"    TEXT,
    "country"       TEXT NOT NULL,
    "isDefault"     BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey: Address → User
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex: Address
CREATE INDEX "Address_userId_idx" ON "Address"("userId");
CREATE INDEX "Address_userId_isDefault_idx" ON "Address"("userId", "isDefault");

-- Add phone to User
ALTER TABLE "User" ADD COLUMN "phone" TEXT;

-- Add checkout and shipping fields to Order
ALTER TABLE "Order"
    ADD COLUMN "discountAmount"        DECIMAL(10,2),
    ADD COLUMN "appliedPromoCode"      TEXT,
    ADD COLUMN "appliedPromoCodeId"    TEXT,
    ADD COLUMN "paymentMethod"         "PaymentMethod" NOT NULL DEFAULT 'COD',
    ADD COLUMN "addressId"             TEXT,
    ADD COLUMN "shippingFullName"      TEXT,
    ADD COLUMN "shippingPhone"         TEXT,
    ADD COLUMN "shippingStreetAddress" TEXT,
    ADD COLUMN "shippingApartment"     TEXT,
    ADD COLUMN "shippingCity"          TEXT,
    ADD COLUMN "shippingState"         TEXT,
    ADD COLUMN "shippingPostalCode"    TEXT,
    ADD COLUMN "shippingCountry"       TEXT;

-- AddForeignKey: Order → Address (soft ref)
ALTER TABLE "Order" ADD CONSTRAINT "Order_addressId_fkey"
    FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Order → PromoCode (soft ref)
ALTER TABLE "Order" ADD CONSTRAINT "Order_appliedPromoCodeId_fkey"
    FOREIGN KEY ("appliedPromoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: Order.addressId
CREATE INDEX "Order_addressId_idx" ON "Order"("addressId");
