import { describe, it, expect, afterEach, vi } from 'vitest';

// Don't let config.ts reload the real .env — we're testing process.env directly.
vi.mock('dotenv/config', () => ({}));

/**
 * config.ts reads process.env at import time, so each case re-imports it with a
 * fresh module registry after tweaking the environment.
 */
const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('config', () => {
  it('throws when DATABASE_URL is missing', async () => {
    vi.resetModules();
    delete process.env.DATABASE_URL;
    await expect(import('../config')).rejects.toThrow(/DATABASE_URL/);
  });

  it('defaults port, kafka broker, and rate limit', async () => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://x';
    delete process.env.PORT;
    delete process.env.KAFKA_BROKER;
    delete process.env.ORDER_RATE_LIMIT_PER_MINUTE;
    const { config } = await import('../config');
    expect(config).toMatchObject({ port: 4000, kafkaBroker: 'localhost:9094', orderRateLimitPerMinute: 120 });
  });

  it('rejects a non-numeric PORT', async () => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://x';
    process.env.PORT = 'not-a-number';
    await expect(import('../config')).rejects.toThrow(/PORT/);
  });
});
