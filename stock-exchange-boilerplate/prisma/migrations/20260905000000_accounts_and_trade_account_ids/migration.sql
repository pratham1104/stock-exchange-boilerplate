-- AlterTable: Trade gains the two settlement counterparties.
-- Added with a throwaway default so the migration is safe on a table with existing
-- rows; the application always writes real account ids.
ALTER TABLE "Trade" ADD COLUMN "buyAccountId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Trade" ADD COLUMN "sellAccountId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Trade" ALTER COLUMN "buyAccountId" DROP DEFAULT;
ALTER TABLE "Trade" ALTER COLUMN "sellAccountId" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Trade_buyAccountId_idx" ON "Trade"("buyAccountId");
CREATE INDEX "Trade_sellAccountId_idx" ON "Trade"("sellAccountId");

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cashBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("accountId", "symbol")
);

-- CreateIndex
CREATE INDEX "Position_symbol_idx" ON "Position"("symbol");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
