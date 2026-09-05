-- Postgres becomes the source of truth (write-through from the API).
--
-- `Order.accountId` and `Account.apiKeyHash` are new NOT NULL columns with no sensible
-- backfill for pre-existing rows (old accounts have no recoverable key; old orders have
-- no recorded owner). Those rows were only ever a lossy read-model projection and are
-- orphaned now, so this migration clears the operational tables before adding the columns.
-- Trade history is cleared too since it references the removed orders/accounts.
DELETE FROM "Trade";
DELETE FROM "Position";
DELETE FROM "Order";
DELETE FROM "Account";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "accountId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "apiKeyHash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Account_apiKeyHash_key" ON "Account"("apiKeyHash");

-- CreateIndex
CREATE INDEX "Order_accountId_idx" ON "Order"("accountId");
