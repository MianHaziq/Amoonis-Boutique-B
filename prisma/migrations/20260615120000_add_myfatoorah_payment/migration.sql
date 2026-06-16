-- CreateEnum (idempotent: tolerate a DB where the type already exists from an earlier
-- manual apply / db push, so `migrate deploy` never aborts with "type already exists").
DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum (idempotent). The new value is not used elsewhere in this migration, so it
-- is safe to run inside the migration's transaction (PostgreSQL 12+).
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'MYFATOORAH';

-- AlterTable (idempotent)
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS "paymentInvoiceId" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentTransactionId" TEXT;
