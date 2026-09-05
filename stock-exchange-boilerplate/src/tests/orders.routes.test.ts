import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

const { db, FakePrismaError } = vi.hoisted(() => {
  class FakePrismaError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    db: { orders: new Map<string, Record<string, unknown>>(), trades: new Map<string, Record<string, unknown>>() },
    FakePrismaError,
  };
});

vi.mock('../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaError },
}));

vi.mock('../db/prisma', () => ({
  prisma: {
    order: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => db.orders.get(id) ?? null,
    },
    trade: {
      findMany: async ({ where: { symbol } }: { where: { symbol: string } }) =>
        [...db.trades.values()].filter((t) => t.symbol === symbol),
    },
  },
}));

const { createApp } = await import('../app');
const { exchangeService } = await import('../engine/ExchangeService');

const app = createApp();

beforeEach(() => {
  db.orders.clear();
  db.trades.clear();
});

describe('POST /api/orders', () => {
  it('rejects an invalid body with 400', async () => {
    const res = await request(app).post('/api/orders').send({ symbol: 'AAPL' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('accepts a resting limit order as OPEN', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RTE1', side: 'BUY', type: 'LIMIT', price: 100, quantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'OPEN', trades: [], remainingQuantity: 10 });
    expect(res.body.orderId).toEqual(expect.any(String));
  });

  it('reports REJECTED for a market order with no liquidity (not FILLED)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RTE2', side: 'BUY', type: 'MARKET', price: null, quantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'REJECTED', remainingQuantity: 10, trades: [] });
  });

  it('reports FILLED for a fully matched order', async () => {
    await request(app).post('/api/orders').send({ symbol: 'RTE3', side: 'SELL', type: 'LIMIT', price: 50, quantity: 5 });

    const res = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RTE3', side: 'BUY', type: 'LIMIT', price: 50, quantity: 5 });

    expect(res.body).toMatchObject({ status: 'FILLED', remainingQuantity: 0 });
    expect(res.body.trades).toHaveLength(1);
  });

  it('forwards a matching-engine failure to the JSON error handler instead of hanging', async () => {
    const spy = vi.spyOn(exchangeService, 'submitOrder').mockRejectedValueOnce(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RTE4', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    spy.mockRestore();
    consoleError.mockRestore();
  });
});

describe('DELETE /api/orders/:symbol/:orderId', () => {
  it('cancels a resting order', async () => {
    const placed = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RTE5', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    const res = await request(app).delete(`/api/orders/RTE5/${placed.body.orderId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: placed.body.orderId });
  });

  it('404s for an order that does not exist', async () => {
    const res = await request(app).delete('/api/orders/RTE5/missing-id');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/orders/:symbol/book', () => {
  it('returns the in-memory book snapshot', async () => {
    await request(app).post('/api/orders').send({ symbol: 'RTE6', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    const res = await request(app).get('/api/orders/RTE6/book');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RTE6', bids: [{ price: 10, quantity: 1, orderCount: 1 }] });
  });
});

describe('GET /api/orders/:symbol/trades (Postgres read model)', () => {
  it('returns trades recorded in the read model', async () => {
    db.trades.set('t1', { id: 't1', symbol: 'RTE7', price: 10, quantity: 1, timestamp: new Date() });

    const res = await request(app).get('/api/orders/RTE7/trades');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RTE7', count: 1 });
    expect(res.body.trades).toHaveLength(1);
  });

  it('returns an empty list, not an error, for a symbol with no trades', async () => {
    const res = await request(app).get('/api/orders/RTE-NONE/trades');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RTE-NONE', count: 0, trades: [] });
  });

  it('returns 503 when the read model is unreachable', async () => {
    const { prisma } = await import('../db/prisma');
    const spy = vi.spyOn(prisma.trade, 'findMany').mockRejectedValueOnce(new Error('connection refused'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/orders/RTE8/trades');

    expect(res.status).toBe(503);
    spy.mockRestore();
    consoleError.mockRestore();
  });
});

describe('GET /api/orders/:id (Postgres read model)', () => {
  it('returns the order when present in the read model', async () => {
    db.orders.set('order-9', { id: 'order-9', symbol: 'RTE9', status: 'OPEN' });

    const res = await request(app).get('/api/orders/order-9');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'order-9', status: 'OPEN' });
  });

  it('404s when the order is not in the read model', async () => {
    const res = await request(app).get('/api/orders/does-not-exist');
    expect(res.status).toBe(404);
  });
});
