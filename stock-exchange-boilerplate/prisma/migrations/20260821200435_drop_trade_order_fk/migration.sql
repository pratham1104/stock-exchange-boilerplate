-- DropForeignKey
ALTER TABLE "Trade" DROP CONSTRAINT "Trade_buyOrderId_fkey";

-- DropForeignKey
ALTER TABLE "Trade" DROP CONSTRAINT "Trade_sellOrderId_fkey";

-- CreateIndex
CREATE INDEX "Trade_buyOrderId_idx" ON "Trade"("buyOrderId");

-- CreateIndex
CREATE INDEX "Trade_sellOrderId_idx" ON "Trade"("sellOrderId");
