-- Per-line cash arrangement moves from ORDER-level to PER-ITEM.
-- CartItem carries the per-unit request (fee resolved at checkout, not stored here).
ALTER TABLE "CartItem" ADD COLUMN     "cashArrangementAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementDenomination" INTEGER,
ADD COLUMN     "cashArrangementNote" TEXT;

-- OrderItem carries the per-unit snapshot (amount + denomination + note + computed fee/feeVat).
ALTER TABLE "OrderItem" ADD COLUMN     "cashArrangementAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementDenomination" INTEGER,
ADD COLUMN     "cashArrangementFeeAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementFeeVatAmount" DECIMAL(10,2),
ADD COLUMN     "cashArrangementNote" TEXT,
ADD COLUMN     "cashArrangementRequested" BOOLEAN NOT NULL DEFAULT false;
