-- AlterEnum
-- Grant managers granular access to the analytics dashboards and region CRUD.
-- Additive only: existing managerPermissions arrays are untouched.
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'ANALYTICS';
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'REGIONS';
