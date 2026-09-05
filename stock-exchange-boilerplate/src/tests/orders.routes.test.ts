import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeFakePrisma } from './helpers/fakePrisma';

const mockDb = makeFakePrisma();

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  isProducerConnected: () => true,
  connectProducer: vi.fn().mockResolvedValue(undefined),
  disconnectProducer: vi.fn().mockResolvedValue(undefined),
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

vi.mock('../db/prisma', () => ({ prisma: mockDb.client, pingDatabase: async () => true }));

const helper = mockDb;

const { createApp } = await import('../app');
const { exchangeService } = await import('../engine/ExchangeService');
const { accountService } = await import('../engine/AccountService');

const app = createApp();
const authHeader = (key: string) => ({ Authorization: `Bearer ${key}` });

/** Open a funded account (cash and optionally shares) and return its bearer key. */
async function funded(cash: number, shares?: { symbol: string; quantity: number }): Promise<string> {
  const res = await request(app).post('/api/accounts').send({ name: `a-${Math.random()}`, startingCash: cash });
  const key = res.body.apiKey as string;
  if (shares) await request(app).post('/api/accounts/me/deposit').set(authHeader(key)).send(shares);
  return key;
}

beforeEach(() => {
  helper.reset();
  accountService.hydrate([]);
  // fresh in-memory books between tests
  (exchangeService as unknown as { books: Map<string, unknown> }).books.clear();
});

describe('POST /api/orders', () => {
  it('401s without an Authorization header', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ symbol: 'RT0', side: 'BUY', type: 'LIMIT', price: 1, quantity: 1 });
    expect(res.status).toBe(401);
  });

  it('400s on an invalid body', async () => {
    const key = await funded(1000);
    const res = await request(app).post('/api/orders').set(authHeader(key)).send({ symbol: 'RT1' });
    expect(res.status).toBe(400);
  });

  it('accepts a resting limit buy as OPEN, reserves cash, and write-throughs the row', async () => {
    const key = await funded(1000);

    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT2', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'OPEN', trades: [], remainingQuantity: 10 });
    expect(helper.stores.orders.get(res.body.orderId)).toMatchObject({ status: 'OPEN', symbol: 'RT2' });

    const me = await request(app).get('/api/accounts/me').set(authHeader(key));
    expect(me.body).toMatchObject({ cashBalance: 900, reservedCash: 100 });
  });

  it('422s when the account cannot cover the order', async () => {
    const key = await funded(50);
    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT3', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 });
    expect(res.status).toBe(422);
    expect(res.body.reason).toMatch(/available/);
  });

  it('reports REJECTED for a market buy with no liquidity', async () => {
    const key = await funded(100000);
    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT4', side: 'BUY', type: 'MARKET', price: null, quantity: 10 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'REJECTED', remainingQuantity: 10, trades: [] });
    expect(helper.stores.orders.get(res.body.orderId)).toMatchObject({ status: 'REJECTED' });
  });

  it('settles a full match end to end', async () => {
    const sellerKey = await funded(0, { symbol: 'RT5', quantity: 5 });
    await request(app)
      .post('/api/orders')
      .set(authHeader(sellerKey))
      .send({ symbol: 'RT5', side: 'SELL', type: 'LIMIT', price: 50, quantity: 5 });

    const buyerKey = await funded(1000);
    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(buyerKey))
      .send({ symbol: 'RT5', side: 'BUY', type: 'LIMIT', price: 50, quantity: 5 });

    expect(res.body).toMatchObject({ status: 'FILLED', remainingQuantity: 0 });
    expect(res.body.trades).toHaveLength(1);

    const buyerMe = await request(app).get('/api/accounts/me').set(authHeader(buyerKey));
    expect(buyerMe.body).toMatchObject({ cashBalance: 750, positions: [{ symbol: 'RT5', quantity: 5 }] });
    const sellerMe = await request(app).get('/api/accounts/me').set(authHeader(sellerKey));
    expect(sellerMe.body).toMatchObject({ cashBalance: 250, positions: [] });

    expect(helper.stores.trades.size).toBe(1);
  });

  it('503s when the write-through transaction fails', async () => {
    const key = await funded(1000);
    const spy = vi.spyOn(helper.client, '$transaction').mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT6', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    expect(res.status).toBe(503);
    spy.mockRestore();
  });

  it('forwards an unexpected engine failure to the JSON error handler', async () => {
    const key = await funded(1000);
    const spy = vi.spyOn(exchangeService, 'submitOrder').mockRejectedValueOnce(new Error('boom'));

    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT7', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    spy.mockRestore();
  });

  it('rate-limits after the configured number of submissions', async () => {
    const key = await funded(100000);
    let last = 201;
    for (let i = 0; i < 130; i++) {
      const r = await request(app)
        .post('/api/orders')
        .set(authHeader(key))
        .send({ symbol: 'RT-RL', side: 'BUY', type: 'LIMIT', price: 1, quantity: 1 });
      last = r.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('DELETE /api/orders/:symbol/:orderId', () => {
  it('cancels a resting order you own and frees the reservation', async () => {
    const key = await funded(1000);
    const placed = await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT8', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 });

    const res = await request(app).delete(`/api/orders/RT8/${placed.body.orderId}`).set(authHeader(key));
    expect(res.status).toBe(200);
    expect(helper.stores.orders.get(placed.body.orderId)).toMatchObject({ status: 'CANCELLED' });

    const me = await request(app).get('/api/accounts/me').set(authHeader(key));
    expect(me.body).toMatchObject({ cashBalance: 1000, reservedCash: 0 });
  });

  it("403s when cancelling another account's order", async () => {
    const ownerKey = await funded(1000);
    const placed = await request(app)
      .post('/api/orders')
      .set(authHeader(ownerKey))
      .send({ symbol: 'RT9', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    const otherKey = await funded(1000);
    const res = await request(app).delete(`/api/orders/RT9/${placed.body.orderId}`).set(authHeader(otherKey));
    expect(res.status).toBe(403);
  });

  it('404s for an unknown order', async () => {
    const key = await funded(1000);
    const res = await request(app).delete('/api/orders/RT8/nope').set(authHeader(key));
    expect(res.status).toBe(404);
  });
});

describe('read endpoints', () => {
  it('GET /:symbol/book returns the in-memory snapshot (no auth)', async () => {
    const key = await funded(1000);
    await request(app)
      .post('/api/orders')
      .set(authHeader(key))
      .send({ symbol: 'RT10', side: 'BUY', type: 'LIMIT', price: 10, quantity: 1 });

    const res = await request(app).get('/api/orders/RT10/book');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RT10', bids: [{ price: 10, quantity: 1, orderCount: 1 }] });
  });

  it('GET /:symbol/trades returns rows from Postgres', async () => {
    helper.stores.trades.set('t1', { id: 't1', symbol: 'RT11', price: 10, quantity: 1, timestamp: new Date() });
    const res = await request(app).get('/api/orders/RT11/trades');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'RT11', count: 1 });
  });

  it('GET /:symbol/trades 503s when the DB is down', async () => {
    const spy = vi.spyOn(helper.client.trade, 'findMany').mockRejectedValueOnce(new Error('down'));
    const res = await request(app).get('/api/orders/RT12/trades');
    expect(res.status).toBe(503);
    spy.mockRestore();
  });

  it('GET /:id returns / 404s from Postgres', async () => {
    helper.stores.orders.set('order-13', { id: 'order-13', symbol: 'RT13', status: 'OPEN' });
    expect((await request(app).get('/api/orders/order-13')).status).toBe(200);
    expect((await request(app).get('/api/orders/missing')).status).toBe(404);
  });
});
