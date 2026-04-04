-- CreateEnum
CREATE TYPE "ManagerPermission" AS ENUM ('PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS', 'BANNERS', 'CONTACT', 'SETTINGS');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'MANAGER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "managerTitle" TEXT,
ADD COLUMN "managerPermissions" "ManagerPermission"[] DEFAULT ARRAY[]::"ManagerPermission"[];
