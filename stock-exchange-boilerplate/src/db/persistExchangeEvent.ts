import { prisma } from './prisma';
import { Prisma } from '../generated/prisma/client';
import { ExchangeEvent, Side } from '../types/domain';

/** Recomputes an order's status from its quantity/filledQuantity after a fill. */
async function recomputeOrderStatus(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status === 'CANCELLED') return;

  const status =
    order.filledQuantity >= order.quantity
      ? 'FILLED'
      : order.filledQuantity > 0
        ? 'PARTIALLY_FILLED'
        : 'OPEN';

  if (status !== order.status) {
    await prisma.order.update({ where: { id: orderId }, data: { status } });
  }
}

/**
 * Increments an order's filledQuantity for a trade. Kafka gives no ordering guarantee across
 * topics, so the order's OrderAccepted event may not have been processed yet — in that case a
 * minimal stub row is created (corrected in place once OrderAccepted does arrive, since that
 * handler's upsert fixes symbol/side/type/price/quantity but never touches filledQuantity/status).
 */
async function applyFill(orderId: string, symbol: string, side: Side, price: number, quantity: number): Promise<void> {
  await prisma.order.upsert({
    where: { id: orderId },
    create: {
      id: orderId,
      symbol,
      side,
      type: 'LIMIT',
      price,
      quantity,
      filledQuantity: quantity,
      status: 'PARTIALLY_FILLED',
      timestamp: new Date(),
    },
    update: {
      filledQuantity: { increment: quantity },
    },
  });
  await recomputeOrderStatus(orderId);
}

/** Applies one exchange event to the read model. */
export async function persistExchangeEvent(event: ExchangeEvent): Promise<void> {
  switch (event.type) {
    case 'OrderAccepted': {
      const { order } = event;
      await prisma.order.upsert({
        where: { id: order.id },
        create: {
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          filledQuantity: 0,
          status: 'OPEN',
          timestamp: new Date(order.timestamp),
        },
        // Only correct the order's own fields here — filledQuantity/status are owned by the
        // fill/cancel handlers, since a stub row from an earlier out-of-order trade may already
        // carry fill progress this event knows nothing about.
        update: {
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
        },
      });
      await recomputeOrderStatus(order.id);
      break;
    }

    case 'TradeExecuted': {
      const { trade } = event;

      // The consumer is at-least-once (offsets commit after processing), so this event can be
      // redelivered after a crash. trade.id is a stable idempotency key: if the row already
      // exists, this trade's fills were already applied and must not be double-counted.
      try {
        await prisma.trade.create({
          data: {
            id: trade.id,
            symbol: trade.symbol,
            price: trade.price,
            quantity: trade.quantity,
            timestamp: new Date(trade.timestamp),
            buyOrderId: trade.buyOrderId,
            sellOrderId: trade.sellOrderId,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return;
        }
        throw err;
      }

      await applyFill(trade.buyOrderId, trade.symbol, 'BUY', trade.price, trade.quantity);
      await applyFill(trade.sellOrderId, trade.symbol, 'SELL', trade.price, trade.quantity);
      break;
    }

    case 'OrderCancelled': {
      // Unlike a fill, we can't safely stub a cancelled order (side/quantity/etc. are unknown
      // here), so if OrderAccepted hasn't landed yet this is dropped — logged by the caller.
      await prisma.order.update({
        where: { id: event.orderId },
        data: { status: 'CANCELLED' },
      });
      break;
    }
  }
}
