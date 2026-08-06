-- CreateEnum
CREATE TYPE "CategoryVisibilityScope" AS ENUM ('HOME_ONLY', 'ENTIRE_STORE');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN "draftScope" "CategoryVisibilityScope" NOT NULL DEFAULT 'HOME_ONLY';
