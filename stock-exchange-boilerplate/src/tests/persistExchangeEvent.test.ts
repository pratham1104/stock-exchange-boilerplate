import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  IncomingOrder,
  Trade,
  OrderAcceptedEvent,
  TradeExecutedEvent,
  OrderCancelledEvent,
  AccountUpdatedEvent,
} from '../types/domain';

/**
 * These tests exercise persistExchangeEvent against an in-memory fake of the
 * Prisma client that mimics the semantics the code actually relies on:
 *   - order.upsert applies `update` (including `{ increment }`) or inserts `create`
 *   - order.update throws a P2025 "record not found" error when the row is missing
 *   - trade.create throws a P2002 unique-constraint error on a duplicate id
 * The focus is the hard stuff: out-of-order delivery, stub rows, trade-id
 * idempotency, and status recomputation.
 */

const { db, FakePrismaError } = vi.hoisted(() => {
  class FakePrismaError extends Error {
    code: string;
    constructor(code: string, message = code) {
      super(message);
      this.name = 'PrismaClientKnownRequestError';
      this.code = code;
    }
  }
  return {
    db: {
      orders: new Map<string, Record<string, unknown>>(),
      trades: new Map<string, Record<string, unknown>>(),
      accounts: new Map<string, Record<string, unknown>>(),
      positions: [] as Array<Record<string, unknown>>,
    },
    FakePrismaError,
  };
});

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as object)) {
      const current = typeof target[key] === 'number' ? (target[key] as number) : 0;
      target[key] = current + (value as { increment: number }).increment;
    } else {
      target[key] = value;
    }
  }
}

vi.mock('../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaError },
}));

vi.mock('../db/prisma', () => ({
  prisma: {
    order: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const row = db.orders.get(id);
        return row ? { ...row } : null;
      },
      update: async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.orders.get(id);
        if (!row) throw new FakePrismaError('P2025', 'Record to update not found.');
        applyData(row, data);
        return { ...row };
      },
      upsert: async ({
        where: { id },
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const row = db.orders.get(id);
        if (row) {
          applyData(row, update);
          return { ...row };
        }
        const created = { ...create };
        db.orders.set(id, created);
        return { ...created };
      },
    },
    trade: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = data.id as string;
        if (db.trades.has(id)) {
          throw new FakePrismaError('P2002', 'Unique constraint failed on the fields: (`id`)');
        }
        const created = { ...data };
        db.trades.set(id, created);
        return { ...created };
      },
    },
    account: {
      upsert: async ({
        where: { id },
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const row = db.accounts.get(id);
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        const created = { ...create };
        db.accounts.set(id, created);
        return { ...created };
      },
    },
    position: {
      deleteMany: async ({ where: { accountId } }: { where: { accountId: string } }) => {
        db.positions = db.positions.filter((p) => p.accountId !== accountId);
      },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        db.positions.push(...data);
      },
    },
  },
}));

const { persistExchangeEvent } = await import('../db/persistExchangeEvent');

const accepted = (order: Partial<IncomingOrder> = {}): OrderAcceptedEvent => ({
  type: 'OrderAccepted',
  order: {
    id: 'order-1',
    symbol: 'AAPL',
    side: 'BUY',
    type: 'LIMIT',
    price: 100,
    quantity: 10,
    timestamp: Date.now(),
    ...order,
  },
});

const traded = (trade: Partial<Trade> = {}): TradeExecutedEvent => ({
  type: 'TradeExecuted',
  trade: {
    id: 'trade-1',
    symbol: 'AAPL',
    buyOrderId: 'order-1',
    sellOrderId: 'order-2',
    buyAccountId: 'buyer',
    sellAccountId: 'seller',
    price: 100,
    quantity: 4,
    timestamp: Date.now(),
    ...trade,
  },
});

const cancelled = (over: Partial<OrderCancelledEvent> = {}): OrderCancelledEvent => ({
  type: 'OrderCancelled',
  orderId: 'order-1',
  symbol: 'AAPL',
  ...over,
});

const accountUpdated = (over: Partial<AccountUpdatedEvent['account']> = {}, reason: AccountUpdatedEvent['reason'] = 'settlement'): AccountUpdatedEvent => ({
  type: 'AccountUpdated',
  reason,
  timestamp: Date.now(),
  account: { id: 'acc-1', name: 'alice', cashBalance: 500, positions: [], ...over },
});

const order = (id: string) => db.orders.get(id);

beforeEach(() => {
  db.orders.clear();
  db.trades.clear();
  db.accounts.clear();
  db.positions = [];
});

describe('persistExchangeEvent', () => {
  describe('OrderAccepted', () => {
    it('inserts a fresh order as OPEN with zero fills', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));

      expect(order('order-1')).toMatchObject({
        id: 'order-1',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'LIMIT',
        price: 100,
        quantity: 10,
        filledQuantity: 0,
        status: 'OPEN',
      });
    });

    it('is idempotent on redelivery and never rolls back fill progress', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));
      await persistExchangeEvent(traded({ id: 'trade-1', buyOrderId: 'order-1', quantity: 4 }));
      expect(order('order-1')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });

      // Kafka redelivers the accept after the fill — must not reset status/fills.
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));

      expect(order('order-1')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });
    });
  });

  describe('TradeExecuted', () => {
    it('records the trade and marks a partially filled order PARTIALLY_FILLED', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', side: 'BUY', quantity: 10 }));
      await persistExchangeEvent(accepted({ id: 'order-2', side: 'SELL', quantity: 10 }));

      await persistExchangeEvent(
        traded({ id: 'trade-1', buyOrderId: 'order-1', sellOrderId: 'order-2', quantity: 4 }),
      );

      expect(db.trades.get('trade-1')).toMatchObject({ price: 100, quantity: 4 });
      expect(order('order-1')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });
      expect(order('order-2')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });
    });

    it('marks an order FILLED once fills reach its quantity', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));

      await persistExchangeEvent(traded({ id: 'trade-1', buyOrderId: 'order-1', quantity: 10 }));

      expect(order('order-1')).toMatchObject({ filledQuantity: 10, status: 'FILLED' });
    });

    it('accumulates multiple partial fills across trades', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));

      await persistExchangeEvent(traded({ id: 'trade-1', buyOrderId: 'order-1', quantity: 4 }));
      expect(order('order-1')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });

      await persistExchangeEvent(traded({ id: 'trade-2', buyOrderId: 'order-1', quantity: 6 }));
      expect(order('order-1')).toMatchObject({ filledQuantity: 10, status: 'FILLED' });
    });

    it('applies a fill to both the buy and the sell order', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', side: 'BUY', quantity: 10 }));
      await persistExchangeEvent(accepted({ id: 'order-2', side: 'SELL', quantity: 10 }));

      await persistExchangeEvent(
        traded({ id: 'trade-1', buyOrderId: 'order-1', sellOrderId: 'order-2', quantity: 6 }),
      );

      expect(order('order-1')).toMatchObject({ filledQuantity: 6 });
      expect(order('order-2')).toMatchObject({ filledQuantity: 6 });
    });

    it('is idempotent on trade.id — a redelivered trade does not double-count fills', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));
      await persistExchangeEvent(accepted({ id: 'order-2', quantity: 10 }));

      const event = traded({ id: 'trade-1', buyOrderId: 'order-1', sellOrderId: 'order-2', quantity: 4 });
      await persistExchangeEvent(event);
      await persistExchangeEvent(event);

      expect(db.trades.size).toBe(1);
      expect(order('order-1')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });
      expect(order('order-2')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });
    });
  });

  describe('out-of-order delivery', () => {
    it('creates a stub row when a trade arrives before its OrderAccepted', async () => {
      await persistExchangeEvent(
        traded({ id: 'trade-1', buyOrderId: 'order-1', price: 100, quantity: 4 }),
      );

      expect(order('order-1')).toMatchObject({
        id: 'order-1',
        symbol: 'AAPL',
        side: 'BUY',
        filledQuantity: 4,
      });
    });

    it('corrects stub metadata when OrderAccepted lands, preserving fill progress', async () => {
      // Trade first: stub is created as a LIMIT @ trade price with qty == fill.
      await persistExchangeEvent(
        traded({ id: 'trade-1', buyOrderId: 'order-1', price: 100, quantity: 4 }),
      );

      // The real order was a MARKET order for 10 — accept arrives late.
      await persistExchangeEvent(
        accepted({ id: 'order-1', side: 'BUY', type: 'MARKET', price: null, quantity: 10 }),
      );

      expect(order('order-1')).toMatchObject({
        type: 'MARKET',
        price: null,
        quantity: 10,
        filledQuantity: 4, // preserved from the earlier stub
        status: 'PARTIALLY_FILLED', // recomputed against the real quantity
      });
    });
  });

  describe('OrderCancelled', () => {
    it('marks an existing order CANCELLED', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1' }));

      await persistExchangeEvent(cancelled({ orderId: 'order-1' }));

      expect(order('order-1')).toMatchObject({ status: 'CANCELLED' });
    });

    it('rejects (no stub) when the order has not been seen yet', async () => {
      await expect(persistExchangeEvent(cancelled({ orderId: 'ghost' }))).rejects.toThrow();
      expect(db.orders.size).toBe(0);
    });

    it('a late fill on a cancelled order does not resurrect its status', async () => {
      await persistExchangeEvent(accepted({ id: 'order-1', quantity: 10 }));
      await persistExchangeEvent(cancelled({ orderId: 'order-1' }));

      await persistExchangeEvent(traded({ id: 'trade-1', buyOrderId: 'order-1', quantity: 4 }));

      expect(order('order-1')).toMatchObject({ status: 'CANCELLED' });
    });
  });

  describe('TradeExecuted account ids', () => {
    it('records both settlement counterparties on the trade row', async () => {
      await persistExchangeEvent(
        traded({ id: 'trade-1', buyAccountId: 'buyer-x', sellAccountId: 'seller-y' }),
      );
      expect(db.trades.get('trade-1')).toMatchObject({ buyAccountId: 'buyer-x', sellAccountId: 'seller-y' });
    });
  });

  describe('AccountUpdated', () => {
    it('upserts the account and its positions from the snapshot', async () => {
      await persistExchangeEvent(
        accountUpdated({ id: 'acc-1', name: 'alice', cashBalance: 750, positions: [{ symbol: 'AAPL', quantity: 5 }] }),
      );

      expect(db.accounts.get('acc-1')).toMatchObject({ name: 'alice', cashBalance: 750 });
      expect(db.positions).toEqual([{ accountId: 'acc-1', symbol: 'AAPL', quantity: 5 }]);
    });

    it('replaces prior positions wholesale on each update', async () => {
      await persistExchangeEvent(
        accountUpdated({ id: 'acc-1', positions: [{ symbol: 'AAPL', quantity: 5 }, { symbol: 'MSFT', quantity: 2 }] }),
      );
      await persistExchangeEvent(
        accountUpdated({ id: 'acc-1', cashBalance: 999, positions: [{ symbol: 'AAPL', quantity: 1 }] }),
      );

      expect(db.accounts.get('acc-1')).toMatchObject({ cashBalance: 999 });
      expect(db.positions).toEqual([{ accountId: 'acc-1', symbol: 'AAPL', quantity: 1 }]);
    });

    it('clears positions when the snapshot has none', async () => {
      await persistExchangeEvent(accountUpdated({ id: 'acc-1', positions: [{ symbol: 'AAPL', quantity: 5 }] }));
      await persistExchangeEvent(accountUpdated({ id: 'acc-1', positions: [] }));

      expect(db.positions).toEqual([]);
    });
  });
});
