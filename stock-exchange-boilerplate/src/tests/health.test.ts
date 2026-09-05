import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { makeFakePrisma } from './helpers/fakePrisma';

const mockDb = makeFakePrisma();
let dbReachable = true;

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  isProducerConnected: () => true,
  connectProducer: vi.fn().mockResolvedValue(undefined),
  disconnectProducer: vi.fn().mockResolvedValue(undefined),
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

vi.mock('../db/prisma', () => ({
  prisma: mockDb.client,
  pingDatabase: async () => dbReachable,
}));

const { createApp } = await import('../app');
const { tradingService } = await import('../engine/TradingService');
const app = createApp();

describe('health endpoints', () => {
  it('GET /health is always 200 (liveness)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready is 200 when Postgres is reachable and not degraded', async () => {
    dbReachable = true;
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', checks: { database: 'ok', consistency: 'ok' } });
  });

  it('GET /health/ready is 503 when Postgres is unreachable', async () => {
    dbReachable = false;
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe('unreachable');
    dbReachable = true;
  });

  it('GET /health/ready is 503 when the trading service is degraded', async () => {
    const spy = vi.spyOn(tradingService, 'isDegraded').mockReturnValue(true);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.consistency).toBe('degraded');
    spy.mockRestore();
  });
});
