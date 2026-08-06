-- CreateEnum
CREATE TYPE "SectionLayout" AS ENUM ('SCROLL', 'GRID');

-- AlterTable
-- Defaults reproduce the pre-existing horizontal rail (SCROLL, 4-up desktop / 2-up
-- mobile), so every existing section is visually unchanged until an admin edits it.
ALTER TABLE "Section" ADD COLUMN     "desktopLayout" "SectionLayout" NOT NULL DEFAULT 'SCROLL',
ADD COLUMN     "desktopColumns" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "mobileLayout" "SectionLayout" NOT NULL DEFAULT 'SCROLL',
ADD COLUMN     "mobileColumns" INTEGER NOT NULL DEFAULT 2;
