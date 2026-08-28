import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { exchangeService } from '../engine/ExchangeService';
import { placeOrderSchema } from '../types/schemas';
import { IncomingOrder } from '../types/domain';

export const ordersRouter = Router();

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

/** GET /api/orders/:symbol/book — current aggregated bid/ask levels for a symbol. */
ordersRouter.get('/:symbol/book', (req: Request, res: Response) => {
  const { symbol } = req.params;
  return res.status(200).json(exchangeService.getSnapshot(symbol));
});
