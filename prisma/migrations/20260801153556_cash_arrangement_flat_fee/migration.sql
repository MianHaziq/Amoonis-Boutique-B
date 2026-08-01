-- AlterTable: region-wide flat cash-arrangement fee schedule (base of the fee precedence chain)
ALTER TABLE "CashArrangementConfig" ADD COLUMN     "feeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "feeStepAmount" DECIMAL(10,2);

-- AlterTable: zone-wide flat cash-arrangement fee schedule (beats regionFlat, below product/category tiers)
ALTER TABLE "DeliveryZone" ADD COLUMN     "cashArrangementFeeMarginPercent" DECIMAL(5,2),
ADD COLUMN     "cashArrangementFeeStepAmount" DECIMAL(10,2);
