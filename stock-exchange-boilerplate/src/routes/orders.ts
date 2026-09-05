import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { tradingService } from '../engine/TradingService';
import { prisma } from '../db/prisma';
import { authenticate } from '../auth/apiKey';
import { rateLimit } from '../http/rateLimit';
import { config } from '../config';
import { placeOrderSchema } from '../types/schemas';
import { IncomingOrder, MatchResult } from '../types/domain';
import { logger } from '../logger';

export const ordersRouter = Router();

/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware — it becomes an unhandled rejection and the request hangs.
 * Wrap any handler that awaits into one that forwards failures to `next`.
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

/**
 * The GET-by-id / trade-history endpoints read straight from Postgres (the
 * source of truth, kept write-through-current by the API). If Postgres is
 * unreachable they return 503; the in-memory book endpoint is unaffected.
 */
async function fromDatabase(res: Response, respond: () => Promise<Response>): Promise<Response> {
  try {
    return await respond();
  } catch (err) {
    logger.error({ err }, 'order read query failed');
    return res.status(503).json({ error: 'Database unavailable' });
  }
}

/**
 * Client-facing status string. remainingOrder is null both when an order fully
 * filled and when a MARKET order's unfilled remainder was dropped, so
 * filledQuantity is what distinguishes them.
 */
function describeStatus(
  order: IncomingOrder,
  result: MatchResult,
): 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'REJECTED' {
  if (result.remainingOrder) {
    return result.remainingOrder.filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
  }
  if (result.filledQuantity === 0) return 'REJECTED';
  return result.filledQuantity < order.quantity ? 'PARTIALLY_FILLED' : 'FILLED';
}

const orderRateLimit = rateLimit({
  windowMs: 60_000,
  max: config.orderRateLimitPerMinute,
  key: (req) => req.accountId ?? req.ip ?? 'anon',
});

/**
 * POST /api/orders — submit an order for the authenticated account. Funds/shares
 * are reserved before matching; an order the account can't cover is rejected 422.
 * The match + fills + balances are written to Postgres in one transaction.
 */
ordersRouter.post(
  '/',
  authenticate,
  orderRateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = placeOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const order: IncomingOrder = {
      id: uuidv4(),
      accountId: req.accountId as string,
      ...parsed.data,
      timestamp: Date.now(),
    };

    const outcome = await tradingService.submitOrder(order);
    if (outcome.status === 'rejected') {
      return res.status(422).json({ error: 'Order rejected', reason: outcome.reason });
    }
    if (outcome.status === 'error') {
      return res.status(503).json({ error: 'Order could not be recorded, state is being reconciled' });
    }

    const { result } = outcome;
    return res.status(201).json({
      orderId: order.id,
      trades: result.trades,
      status: describeStatus(order, result),
      remainingQuantity: result.remainingOrder
        ? result.remainingOrder.quantity - result.remainingOrder.filledQuantity
        : order.quantity - result.filledQuantity,
    });
  }),
);

/** DELETE /api/orders/:symbol/:orderId — cancel a resting order you own. */
ordersRouter.delete(
  '/:symbol/:orderId',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { symbol, orderId } = req.params;
    const outcome = await tradingService.cancelOrder(symbol, orderId, req.accountId as string);

    if (outcome.status === 'forbidden') {
      return res.status(403).json({ error: 'That order belongs to another account' });
    }
    if (outcome.status === 'not_found') {
      return res.status(404).json({ error: 'Order not found or already filled' });
    }
    if (outcome.status === 'error') {
      return res.status(503).json({ error: 'Cancel could not be recorded, state is being reconciled' });
    }
    return res.status(200).json({ cancelled: outcome.order.id });
  }),
);

/** GET /api/orders/:symbol/book — current aggregated bid/ask levels (in-memory book). */
ordersRouter.get('/:symbol/book', (req: Request, res: Response) => {
  const { symbol } = req.params;
  return res.status(200).json(tradingService.getSnapshot(symbol));
});

/**
 * GET /api/orders/:symbol/trades — trade history for a symbol from Postgres.
 * Most recent first; `?limit=` (1–500, default 100).
 */
ordersRouter.get('/:symbol/trades', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

  return fromDatabase(res, async () => {
    const trades = await prisma.trade.findMany({
      where: { symbol },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return res.status(200).json({ symbol, count: trades.length, trades });
  });
});

/** GET /api/orders/:id — one order's status + fill progress from Postgres. */
ordersRouter.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  return fromDatabase(res, async () => {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    return res.status(200).json(order);
  });
});
