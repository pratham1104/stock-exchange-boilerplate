import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { rateLimit } from '../http/rateLimit';

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json: vi.fn(),
  } as unknown as Response & { headers: Record<string, string>; statusCode: number };
}

const req = (id: string) => ({ accountId: id, ip: '1.2.3.4' }) as unknown as Request;

describe('rateLimit', () => {
  it('allows up to max within the window, then 429s', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3, key: (r) => (r as { accountId: string }).accountId });
    const next = vi.fn();

    for (let i = 0; i < 3; i++) mw(req('acct'), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);

    const res = fakeRes();
    mw(req('acct'), res, next);
    expect(res.statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(3); // not called a 4th time
  });

  it('tracks callers independently', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, key: (r) => (r as { accountId: string }).accountId });
    const next = vi.fn();

    mw(req('a'), fakeRes(), next);
    const resA = fakeRes();
    mw(req('a'), resA, next);
    expect(resA.statusCode).toBe(429);

    const resB = fakeRes();
    mw(req('b'), resB, next);
    expect(resB.statusCode).toBe(200); // different key, still allowed
  });

  it('resets after the window elapses', () => {
    vi.useFakeTimers();
    const mw = rateLimit({ windowMs: 1_000, max: 1, key: () => 'k' });
    const next = vi.fn();

    mw(req('k'), fakeRes(), next);
    const blocked = fakeRes();
    mw(req('k'), blocked, next);
    expect(blocked.statusCode).toBe(429);

    vi.advanceTimersByTime(1_100);
    const allowed = fakeRes();
    mw(req('k'), allowed, next);
    expect(allowed.statusCode).toBe(200);
    vi.useRealTimers();
  });

  it('sets RateLimit headers', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5, key: () => 'k' });
    const res = fakeRes();
    mw(req('k'), res, vi.fn());
    expect(res.headers['RateLimit-Limit']).toBe('5');
    expect(res.headers['RateLimit-Remaining']).toBe('4');
  });
});
