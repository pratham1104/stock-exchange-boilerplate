import type { PrismaClient } from '../generated/prisma/client';
import { RestingOrder } from '../types/domain';
import { AccountSnapshot } from './persistence';

/**
 * Startup rehydration: rebuild in-memory state from Postgres (the source of
 * truth) so a restart recovers exactly. Called once from index.ts before the
 * server starts accepting requests.
 */

/** Every account plus its holdings, shaped for AccountService.hydrate(). */
export async function loadAccountSnapshots(prisma: PrismaClient): Promise<AccountSnapshot[]> {
  const accounts = await prisma.account.findMany({ include: { positions: true } });
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    apiKeyHash: a.apiKeyHash,
    cashBalance: a.cashBalance,
    positions: a.positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity })),
  }));
}

/**
 * Orders still live on the book (OPEN / PARTIALLY_FILLED), oldest first so they
 * re-insert in time priority. MARKET orders never rest, so these are all LIMIT.
 */
export async function loadOpenOrders(prisma: PrismaClient): Promise<RestingOrder[]> {
  const rows = await prisma.order.findMany({
    where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
    orderBy: { timestamp: 'asc' },
  });
  return rows.map((o) => ({
    id: o.id,
    accountId: o.accountId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    price: o.price,
    quantity: o.quantity,
    filledQuantity: o.filledQuantity,
    timestamp: o.timestamp.getTime(),
  }));
}
