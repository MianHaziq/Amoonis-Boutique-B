-- CreateEnum
CREATE TYPE "SectionKind" AS ENUM ('CUSTOM', 'BEST_SELLERS', 'NEW_ARRIVALS');

-- AlterTable
ALTER TABLE "Section" ADD COLUMN     "kind" "SectionKind" NOT NULL DEFAULT 'CUSTOM';
