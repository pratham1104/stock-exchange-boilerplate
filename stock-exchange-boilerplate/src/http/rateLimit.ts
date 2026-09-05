import { Request, Response, NextFunction } from 'express';

/**
 * Tiny fixed-window rate limiter keyed by a caller identity. In-memory and
 * per-process — fine for a single instance; a multi-instance deployment would
 * move the counter to Redis. Deliberately dependency-free.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Opportunistic cleanup so the map doesn't grow unbounded.
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  };
  const timer = setInterval(sweep, opts.windowMs);
  if (typeof timer.unref === 'function') timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const id = opts.key(req);
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, opts.max - entry.count);
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}
