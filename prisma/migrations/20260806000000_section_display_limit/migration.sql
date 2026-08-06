-- AlterTable
-- Per-breakpoint cap on how many of a section's products render. Default 12 matches
-- the pre-existing per-rail cap (HomeSections' PRODUCTS_PER_SECTION), so existing
-- sections are unchanged until an admin lowers/raises it.
ALTER TABLE "Section" ADD COLUMN     "desktopLimit" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "mobileLimit" INTEGER NOT NULL DEFAULT 12;
