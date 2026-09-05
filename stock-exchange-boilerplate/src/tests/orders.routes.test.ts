import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: {
    ORDER_ACCEPTED: 'order.accepted',
    TRADE_EXECUTED: 'trade.executed',
    ORDER_CANCELLED: 'order.cancelled',
    ACCOUNT_UPDATED: 'account.updated',
  },
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

/** Opens a funded account and returns its bearer token + id. */
async function funded(cash = 1_000_000, name = `acct-${Math.random().toString(36).slice(2)}`) {
  const res = await request(app).post('/api/accounts').send({ name, startingCash: cash });
  return { key: res.body.apiKey as string, id: res.body.account.id as string };
}

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

beforeEach(() => {
  db.orders.clear();
  db.trades.clear();
});

describe('POST /api/orders', () => {
  it('401s without an Authorization header', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RT0', side: 'BUY', type: 'LIMIT', price: 1, quantity: 1 });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body with 400', async () => {
    const { key } = await funded();
    const res = await request(app).post('/api/orders').set(auth(key)).send({ symbol: 'RT1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('accepts a resting limit order as OPEN and reserves the cash', async () => {
    const { key, id } = await funded(1000);

    const res = await request(app)
      .post('/api/orders')
      .set(auth(key))
      .send({ symbol: 'RT2', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'OPEN', trades: [], remainingQuantity: 10 });

    const me = await request(app).get('/api/accounts/me').set(auth(key));
    expect(me.body).toMatchObject({ cashBalance: 900, reservedCash: 100 });
    expect(id).toEqual(expect.any(String));
  });

  it('422s when the account cannot cover the order', async () => {
    const { key } = await funded(50);

    const res = await request(app)
      .post('/api/orders')
      .set(auth(key))
      .send({ symbol: 'RT3', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 });

    expect(res.status).toBe(422);
    expect(res.body.reason).toMatch(/available/);
  });

  it('reports REJECTED for a market order with no liquidity (not FILLED)', async () => {
    const { key } = await funded();

    const res = await request(app)
      .post('/api/orders')
      .set(auth(key))
      .send({ symbol: 'RT4', side: 'BUY', type: 'MARKET', price: null, quantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'REJECTED', remainingQuantity: 10, trades: [] });
  });

  it('settles a full match: buyer gets shares, seller gets cash', async () => {
    const seller = await funded(0, 'seller');
    await request(app).post('/api/accounts/me/deposit').set(auth(seller.key)).send({ symbol: 'RT5', quantity: 5 });
    await request(app)
      .post('/api/orders')
      .set(auth(seller.key))
      .send({ symbol: 'RT5', side: 'SELL', type: 'LIMIT', price: 50, quantity: 5 });

    const buyer = await funded(1000, 'buyer');
    const res = await request(app)
      .post('/api/orders')
      .set(auth(buyer.key))
      .send({ symbol: 'RT5', side: 'BUY', type: 'LIMIT', price: 50, quantity: 5 });

    expect(res.body).toMatchObject({ status: 'FILLED', remainingQuantity: 0 });
    expect(res.body.trades).toHaveLength(1);

    const buyerMe = await request(app).get('/api/accounts/me').set(auth(buyer.key));
    expect(buyerMe.body.cashBalance).toBe(750); // 1000 - 5*50
    expect(buyerMe.body.positions).toEqual([{ symbol: 'RT5', quantity: 5 }]);

    const sellerMe = await request(app).get('/api/accounts/me').set(auth(seller.key));
    expect(sellerMe.body.cashBalance).toBe(250); // 5*50
    expect(sellerMe.body.positions).toEqual([]);
  });

  it('forwards a matching-engine failure to the JSON error handler instead of hanging', async () => {
    const { key } = await funded();
    const spy = vi.spyOn(exchangeService, 'submitOrder').mockRejectedValueOnce(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/orders')
      .set(auth(key))
      .send({ symbol: 'RT6', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    spy.mockRestore();
    consoleError.mockRestore();
  });
});

describe('DELETE /api/orders/:symbol/:orderId', () => {
  it('cancels a resting order and frees the reservation', async () => {
    const { key } = await funded(1000);
    const placed = await request(app)
      .post('/api/orders')
      .set(auth(key))
      .send({ symbol: 'RT7', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 });

    const res = await request(app).delete(`/api/orders/RT7/${placed.body.orderId}`).set(auth(key));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: placed.body.orderId });

    const me = await request(app).get('/api/accounts/me').set(auth(key));
    expect(me.body).toMatchObject({ cashBalance: 1000, reservedCash: 0 });
  });

  it("403s when cancelling another account's order", async () => {
    const owner = await funded(1000);
    const placed = await request(app)
      .post('/api/orders')
      .set(auth(owner.key))
      .send({ symbol: 'RT8', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    const other = await funded(1000);
    const res = await request(app).delete(`/api/orders/RT8/${placed.body.orderId}`).set(auth(other.key));

    expect(res.status).toBe(403);
  });

  it('404s for an order that does not exist', async () => {
    const { key } = await funded();
    const res = await request(app).delete('/api/orders/RT7/missing-id').set(auth(key));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/orders/:symbol/book', () => {
  it('returns the in-memory book snapshot (no auth required)', async () => {
    const { key } = await funded(1000);
    await request(app)
      .post('/api/orders')
      .set(auth(key))
      .send({ symbol: 'RT9', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    const res = await request(app).get('/api/orders/RT9/book');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RT9', bids: [{ price: 10, quantity: 1, orderCount: 1 }] });
  });
});

describe('GET /api/orders/:symbol/trades (Postgres read model)', () => {
  it('returns trades recorded in the read model', async () => {
    db.trades.set('t1', { id: 't1', symbol: 'RT10', price: 10, quantity: 1, timestamp: new Date() });
    const res = await request(app).get('/api/orders/RT10/trades');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RT10', count: 1 });
  });

  it('returns 503 when the read model is unreachable', async () => {
    const { prisma } = await import('../db/prisma');
    const spy = vi.spyOn(prisma.trade, 'findMany').mockRejectedValueOnce(new Error('connection refused'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/orders/RT11/trades');

    expect(res.status).toBe(503);
    spy.mockRestore();
    consoleError.mockRestore();
  });
});

describe('GET /api/orders/:id (Postgres read model)', () => {
  it('returns the order when present', async () => {
    db.orders.set('order-12', { id: 'order-12', symbol: 'RT12', status: 'OPEN' });
    const res = await request(app).get('/api/orders/order-12');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'order-12', status: 'OPEN' });
  });

  it('404s when the order is not in the read model', async () => {
    const res = await request(app).get('/api/orders/does-not-exist');
    expect(res.status).toBe(404);
  });
});
