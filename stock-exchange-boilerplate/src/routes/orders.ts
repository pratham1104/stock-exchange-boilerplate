import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { tradingService } from '../engine/TradingService';
import { prisma } from '../db/prisma';
import { authenticate } from '../auth/apiKey';
import { placeOrderSchema } from '../types/schemas';
import { IncomingOrder, MatchResult } from '../types/domain';

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
 * The GET-by-id / trade-history endpoints read from the Postgres read model
 * that the Kafka consumer maintains (see src/consumer.ts). If the consumer
 * isn't running, or Postgres is unreachable, these return 503 rather than
 * a 500 — the in-memory book (POST / DELETE / GET book) is unaffected.
 */
async function fromReadModel(res: Response, respond: () => Promise<Response>): Promise<Response> {
  try {
    return await respond();
  } catch (err) {
    console.error('Read model query failed', err);
    return res.status(503).json({ error: 'Read model unavailable' });
  }
}

/**
 * Derives a client-facing status for a submitted order. remainingOrder is
 * null in two very different cases — fully filled, and a MARKET order whose
 * unfilled remainder was dropped (never rests) — so filledQuantity is what
 * actually distinguishes them.
 */
function describeStatus(
  order: IncomingOrder,
  result: MatchResult,
): 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'REJECTED' {
  if (result.remainingOrder) {
    return result.remainingOrder.filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
  }
  if (result.filledQuantity === 0) return 'REJECTED'; // no liquidity at all (MARKET only)
  return result.filledQuantity < order.quantity ? 'PARTIALLY_FILLED' : 'FILLED';
}

/**
 * POST /api/orders — submit a new order (market or limit) for the authenticated
 * account. Funds/shares are reserved before matching; an order the account
 * can't cover is rejected with 422.
 */
ordersRouter.post(
  '/',
  authenticate,
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
    return res.status(200).json({ cancelled: outcome.order.id });
  }),
);

/** GET /api/orders/:symbol/book — current aggregated bid/ask levels for a symbol (in-memory book). */
ordersRouter.get('/:symbol/book', (req: Request, res: Response) => {
  const { symbol } = req.params;
  return res.status(200).json(tradingService.getSnapshot(symbol));
});

/**
 * GET /api/orders/:symbol/trades — trade history for a symbol from the Postgres read model.
 * Most recent first; capped at 100. `?limit=` overrides (1–500).
 */
ordersRouter.get('/:symbol/trades', (req: Request, res: Response) => {
  const { symbol } = req.params;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

  return fromReadModel(res, async () => {
    const trades = await prisma.trade.findMany({
      where: { symbol },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return res.status(200).json({ symbol, count: trades.length, trades });
  });
});

/**
 * GET /api/orders/:id — status and fill progress for a single order from the Postgres read model.
 * Survives an API restart, unlike GET book (which only knows the in-memory book).
 */
ordersRouter.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  return fromReadModel(res, async () => {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      return res.status(404).json({ error: 'Order not found in read model' });
    }
    return res.status(200).json(order);
  });
});
