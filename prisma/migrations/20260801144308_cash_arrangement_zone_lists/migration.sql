-- AlterTable
ALTER TABLE "DeliveryZone" ADD COLUMN     "cashArrangementDenominations" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "cashArrangementQuickPickAmounts" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
