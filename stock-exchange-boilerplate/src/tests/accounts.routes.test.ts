import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeFakePrisma } from './helpers/fakePrisma';

// `mock`-prefixed so the vi.mock factory below is allowed to reference it.
const mockDb = makeFakePrisma();

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  isProducerConnected: () => true,
  connectProducer: vi.fn().mockResolvedValue(undefined),
  disconnectProducer: vi.fn().mockResolvedValue(undefined),
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

vi.mock('../db/prisma', () => ({
  prisma: mockDb.client,
  pingDatabase: async () => true,
}));

const helper = mockDb;

const { createApp } = await import('../app');
const { accountService } = await import('../engine/AccountService');

const app = createApp();
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

beforeEach(() => {
  helper.reset();
  accountService.hydrate([]);
});

describe('POST /api/accounts', () => {
  it('creates an account, persists it, and returns a one-time API key', async () => {
    const res = await request(app).post('/api/accounts').send({ name: 'trader-joe', startingCash: 250 });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toEqual(expect.any(String));
    expect(res.body.account).toMatchObject({ name: 'trader-joe', cashBalance: 250, reservedCash: 0, positions: [] });
    expect(res.body.account).not.toHaveProperty('apiKey');
    // persisted to the DB
    expect(helper.stores.accounts.get(res.body.account.id)).toMatchObject({ name: 'trader-joe', cashBalance: 250 });
    expect(helper.stores.accounts.get(res.body.account.id)).not.toHaveProperty('apiKey');
  });

  it('rolls back the in-memory account and 503s if the DB write fails', async () => {
    const spy = vi.spyOn(helper.client.account, 'upsert').mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/api/accounts').send({ name: 'unlucky', startingCash: 1 });

    expect(res.status).toBe(503);
    expect([...helper.stores.accounts.keys()]).toHaveLength(0);
    spy.mockRestore();
  });

  it('400s on a missing name', async () => {
    expect((await request(app).post('/api/accounts').send({ startingCash: 1 })).status).toBe(400);
  });
});

describe('GET /api/accounts/me', () => {
  it('401s without a key and with a bad key', async () => {
    expect((await request(app).get('/api/accounts/me')).status).toBe(401);
    expect((await request(app).get('/api/accounts/me').set(auth('bogus'))).status).toBe(401);
  });

  it("returns the caller's own account", async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'me-test', startingCash: 42 });
    const res = await request(app).get('/api/accounts/me').set(auth(created.body.apiKey));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.account.id, cashBalance: 42 });
  });
});

describe('POST /api/accounts/me/deposit', () => {
  it('adds cash and shares, persists, and reflects them in /me', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'depositor', startingCash: 0 });
    const key = created.body.apiKey;

    await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({ cash: 500 });
    const res = await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({ symbol: 'ACME', quantity: 12 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cashBalance: 500, positions: [{ symbol: 'ACME', quantity: 12 }] });
    expect(helper.stores.accounts.get(created.body.account.id)).toMatchObject({ cashBalance: 500 });
    expect(helper.stores.positions).toEqual([{ accountId: created.body.account.id, symbol: 'ACME', quantity: 12 }]);
  });

  it('rolls the deposit back and 503s if persistence fails', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'd2', startingCash: 100 });
    const key = created.body.apiKey;
    const spy = vi.spyOn(helper.client.account, 'upsert').mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({ cash: 999 });

    expect(res.status).toBe(503);
    const me = await request(app).get('/api/accounts/me').set(auth(key));
    expect(me.body.cashBalance).toBe(100); // unchanged
    spy.mockRestore();
  });

  it('400s on an empty deposit body and on symbol without quantity', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'x', startingCash: 0 });
    const key = created.body.apiKey;
    expect((await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({})).status).toBe(400);
    expect((await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({ symbol: 'ACME' })).status).toBe(400);
  });
});
