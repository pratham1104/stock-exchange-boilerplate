import type { PrismaClient } from '../generated/prisma/client';
import { IncomingOrder, Position, StoredOrderStatus, Trade } from '../types/domain';

/**
 * Write-through persistence: Postgres is the source of truth. Every one of these
 * runs inside the same `prisma.$transaction` as the match that produced it (see
 * TradingService), so an order, its fills, and both accounts' new balances land
 * atomically or not at all.
 *
 * Accepts either the PrismaClient or a transaction client.
 */
export type PersistenceClient = Pick<PrismaClient, 'order' | 'trade' | 'account' | 'position'>;

/** Derive stored order status from fill progress. */
export function storedStatus(order: { quantity: number; type: 'LIMIT' | 'MARKET' }, filledQuantity: number): StoredOrderStatus {
  if (filledQuantity <= 0) return order.type === 'MARKET' ? 'REJECTED' : 'OPEN';
  if (filledQuantity + 1e-9 >= order.quantity) return 'FILLED';
  return 'PARTIALLY_FILLED';
}

/** Insert the incoming (taker) order with its post-match state. */
export async function insertOrder(
  db: PersistenceClient,
  order: IncomingOrder,
  filledQuantity: number,
  status: StoredOrderStatus,
): Promise<void> {
  await db.order.create({
    data: {
      id: order.id,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      quantity: order.quantity,
      filledQuantity,
      status,
      timestamp: new Date(order.timestamp),
    },
  });
}

/** Update a resting (maker) order that was (partly) consumed. */
export async function updateOrderFill(
  db: PersistenceClient,
  orderId: string,
  filledQuantity: number,
  status: StoredOrderStatus,
): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { filledQuantity, status } });
}

/** Mark a resting order cancelled. */
export async function markOrderCancelled(db: PersistenceClient, orderId: string): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
}

/** Insert one fill. */
export async function insertTrade(db: PersistenceClient, trade: Trade): Promise<void> {
  await db.trade.create({
    data: {
      id: trade.id,
      symbol: trade.symbol,
      price: trade.price,
      quantity: trade.quantity,
      timestamp: new Date(trade.timestamp),
      buyOrderId: trade.buyOrderId,
      sellOrderId: trade.sellOrderId,
      buyAccountId: trade.buyAccountId,
      sellAccountId: trade.sellAccountId,
    },
  });
}

/** The full persistable state of one account. */
export interface AccountSnapshot {
  id: string;
  name: string;
  apiKeyHash: string;
  cashBalance: number; // settled (gross) cash
  positions: Position[];
}

/** Upsert an account row and replace its positions to match the snapshot. */
export async function writeAccountSnapshot(db: PersistenceClient, snap: AccountSnapshot): Promise<void> {
  await db.account.upsert({
    where: { id: snap.id },
    create: { id: snap.id, name: snap.name, apiKeyHash: snap.apiKeyHash, cashBalance: snap.cashBalance },
    update: { name: snap.name, apiKeyHash: snap.apiKeyHash, cashBalance: snap.cashBalance },
  });
  await db.position.deleteMany({ where: { accountId: snap.id } });
  if (snap.positions.length > 0) {
    await db.position.createMany({
      data: snap.positions.map((p) => ({ accountId: snap.id, symbol: p.symbol, quantity: p.quantity })),
    });
  }
}
