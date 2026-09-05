import { Router, Request, Response } from 'express';
import { pingDatabase } from '../db/prisma';
import { isProducerConnected } from '../kafka/kafkaclient';
import { tradingService } from '../engine/TradingService';

export const healthRouter = Router();

/** Liveness — the process is up. Cheap, no dependency checks. */
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

/**
 * Readiness — safe to route traffic here. Fails if Postgres is unreachable
 * (the source of truth) or a write-through transaction has failed and left
 * in-memory state ahead of the database.
 */
healthRouter.get('/health/ready', async (_req: Request, res: Response) => {
  const dbOk = await pingDatabase();
  const degraded = tradingService.isDegraded();
  const ready = dbOk && !degraded;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database: dbOk ? 'ok' : 'unreachable',
      kafka: isProducerConnected() ? 'connected' : 'disconnected', // informational — publishing is best-effort
      consistency: degraded ? 'degraded' : 'ok',
    },
  });
});
