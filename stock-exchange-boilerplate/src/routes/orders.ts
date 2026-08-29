import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { exchangeService } from '../engine/ExchangeService';
import { prisma } from '../db/prisma';
import { placeOrderSchema } from '../types/schemas';
import { IncomingOrder } from '../types/domain';

export const ordersRouter = Router();

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
 * POST /api/orders — submit a new order (market or limit).
 * Validates the body against placeOrderSchema, assigns a server-side id and
 * timestamp, runs it through the matching engine, and reports the outcome.
 */
ordersRouter.post('/', async (req: Request, res: Response) => {
  const parsed = placeOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const order: IncomingOrder = {
    id: uuidv4(),
    ...parsed.data,
    timestamp: Date.now(),
  };

  const result = await exchangeService.submitOrder(order);

  return res.status(201).json({
    orderId: order.id,
    trades: result.trades,
    // No remainingOrder means it fully filled; otherwise it's either still
    // sitting untouched (OPEN) or partially matched before it started resting.
    status: result.remainingOrder
      ? result.remainingOrder.filledQuantity > 0
        ? 'PARTIALLY_FILLED'
        : 'OPEN'
      : 'FILLED',
    remainingQuantity: result.remainingOrder
      ? result.remainingOrder.quantity - result.remainingOrder.filledQuantity
      : 0,
  });
});

/** DELETE /api/orders/:symbol/:orderId — cancel a resting order before it's filled. */
ordersRouter.delete('/:symbol/:orderId', async (req: Request, res: Response) => {
  const { symbol, orderId } = req.params;
  const removed = await exchangeService.cancelOrder(symbol, orderId);

  if (!removed) {
    return res.status(404).json({ error: 'Order not found or already filled' });
  }

  return res.status(200).json({ cancelled: removed.id });
});

/** GET /api/orders/:symbol/book — current aggregated bid/ask levels for a symbol (in-memory book). */
ordersRouter.get('/:symbol/book', (req: Request, res: Response) => {
  const { symbol } = req.params;
  return res.status(200).json(exchangeService.getSnapshot(symbol));
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
