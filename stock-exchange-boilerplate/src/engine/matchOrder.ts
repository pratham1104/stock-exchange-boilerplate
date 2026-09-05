import { v4 as uuidv4 } from 'uuid';
import { OrderBook } from './OrderBook';
import { IncomingOrder, RestingOrder, MatchResult, Trade } from '../types/domain';

/**
 * Matches an incoming order against the resting book for its symbol.
 * Pure function w.r.t. the book (mutates the passed-in OrderBook instance,
 * but has no other side effects — no network, no DB, no logging).
 *
 * Price-time priority: always match against the best opposite price,
 * and within a price level, the oldest resting order first.
 */
export function matchOrder(incoming: IncomingOrder, book: OrderBook): MatchResult {
  const trades: Trade[] = [];
  const opposingSide: 'BUY' | 'SELL' = incoming.side === 'BUY' ? 'SELL' : 'BUY';

  let remainingQty = incoming.quantity;

  while (remainingQty > 0) {
    const top = book.peekTop(opposingSide);
    if (!top) break; // no liquidity left on the opposite side

    const topRemainingQty = top.quantity - top.filledQuantity;

    const pricesCross =
      incoming.type === 'MARKET' ||
      (incoming.side === 'BUY' ? incoming.price! >= top.price! : incoming.price! <= top.price!);

    if (!pricesCross) break; // best opposing price is worse than what we're willing to take

    const tradeQty = Math.min(remainingQty, topRemainingQty);
    const tradePrice = top.price!; // resting order's price always wins (price improvement for taker)

    trades.push({
      id: uuidv4(),
      symbol: incoming.symbol,
      buyOrderId: incoming.side === 'BUY' ? incoming.id : top.id,
      sellOrderId: incoming.side === 'SELL' ? incoming.id : top.id,
      price: tradePrice,
      quantity: tradeQty,
      timestamp: Date.now(),
    });

    book.consumeTop(opposingSide, tradeQty);
    remainingQty -= tradeQty;
  }

  const filledQty = incoming.quantity - remainingQty;

  if (remainingQty === 0) {
    return { trades, remainingOrder: null, filledQuantity: filledQty };
  }

  if (incoming.type === 'MARKET') {
    // Market orders never rest on the book — unfilled remainder is just dropped/rejected.
    // filledQuantity may be 0 (no liquidity at all) or partial — the caller distinguishes
    // "fully filled" from "rejected"/"partially filled and rest dropped" using this value.
    return { trades, remainingOrder: null, filledQuantity: filledQty };
  }

  // LIMIT order with leftover quantity: rests on the book.
  const restingOrder: RestingOrder = {
    ...incoming,
    filledQuantity: filledQty,
  };
  book.addOrder(restingOrder);

  return { trades, remainingOrder: restingOrder, filledQuantity: filledQty };
}
