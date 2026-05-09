-- Make Address contact + location fields optional. Recipient fullName/phone are now
-- pulled from the User profile at checkout, and city/country/streetAddress can be
-- pre-filled or left blank in the simplified address form. Existing rows keep their
-- values (no data change).

ALTER TABLE "Address" ALTER COLUMN "fullName" DROP NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "streetAddress" DROP NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "city" DROP NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "country" DROP NOT NULL;
