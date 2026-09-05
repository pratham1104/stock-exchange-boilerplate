import { describe, it, expect, vi } from 'vitest';
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

vi.mock('../db/prisma', () => ({ prisma: {} }));

const { createApp } = await import('../app');
const app = createApp();

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

describe('POST /api/accounts', () => {
  it('creates an account and returns a one-time API key', async () => {
    const res = await request(app).post('/api/accounts').send({ name: 'trader-joe', startingCash: 250 });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toEqual(expect.any(String));
    expect(res.body.account).toMatchObject({ name: 'trader-joe', cashBalance: 250, reservedCash: 0, positions: [] });
    expect(res.body.account).not.toHaveProperty('apiKey');
  });

  it('400s on a missing name', async () => {
    const res = await request(app).post('/api/accounts').send({ startingCash: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/accounts/me', () => {
  it('401s without a key and 401s with a bad key', async () => {
    expect((await request(app).get('/api/accounts/me')).status).toBe(401);
    expect((await request(app).get('/api/accounts/me').set(auth('bogus'))).status).toBe(401);
  });

  it('returns the caller’s own account', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'me-test', startingCash: 42 });
    const res = await request(app).get('/api/accounts/me').set(auth(created.body.apiKey));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.account.id, cashBalance: 42 });
  });
});

describe('POST /api/accounts/me/deposit', () => {
  it('adds cash and shares and reflects them in /me', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'depositor', startingCash: 0 });
    const key = created.body.apiKey;

    await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({ cash: 500 });
    const res = await request(app).post('/api/accounts/me/deposit').set(auth(key)).send({ symbol: 'ACME', quantity: 12 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cashBalance: 500, positions: [{ symbol: 'ACME', quantity: 12 }] });
  });

  it('400s on an empty deposit body', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'x', startingCash: 0 });
    const res = await request(app).post('/api/accounts/me/deposit').set(auth(created.body.apiKey)).send({});
    expect(res.status).toBe(400);
  });

  it('400s when symbol is given without quantity', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'y', startingCash: 0 });
    const res = await request(app)
      .post('/api/accounts/me/deposit')
      .set(auth(created.body.apiKey))
      .send({ symbol: 'ACME' });
    expect(res.status).toBe(400);
  });
});
