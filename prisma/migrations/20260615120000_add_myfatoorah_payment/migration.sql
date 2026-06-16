-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'MYFATOORAH';

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN "paymentInvoiceId" TEXT,
  ADD COLUMN "paymentTransactionId" TEXT;
