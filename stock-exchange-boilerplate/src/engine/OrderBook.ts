import { RestingOrder, BookSnapshot } from '../types/domain';

/**
 * Single-symbol order book.
 * Bids sorted descending by price (best bid = highest price, index 0).(BUY)
 * Asks sorted ascending by price (best ask = lowest price, index 0).(SELL)
 * Within a price level, orders are FIFO (price-time priority).
 *
 * NOTE: This is a naive O(n log n) re-sort-on-insert implementation on
 * purpose — get correctness and tests passing first. Swap the internal
 * storage for a TreeMap-like structure (e.g. sorted price levels via a
 * balanced tree or a price-indexed array of queues) once you need real
 * throughput. Don't optimize this before it's tested and correct.
 */
export class OrderBook {
  readonly symbol: string;
  private bids: RestingOrder[] = [];
  private asks: RestingOrder[] = [];

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  /** Highest-priority resting buy order, or null if the bid side is empty. */
  getBestBid(): RestingOrder | null {
    return this.bids[0] ?? null;
  }

  /** Highest-priority resting sell order, or null if the ask side is empty. */
  getBestAsk(): RestingOrder | null {
    return this.asks[0] ?? null;
  }

  /** Full bid side in priority order, read-only (for snapshotting/inspection). */
  getBidsRaw(): readonly RestingOrder[] {
    return this.bids;
  }

  /** Full ask side in priority order, read-only (for snapshotting/inspection). */
  getAsksRaw(): readonly RestingOrder[] {
    return this.asks;
  }

  /** Insert a resting (unfilled or partially filled) order into the correct side, maintaining price-time priority. */
  addOrder(order: RestingOrder): void {
    if (order.price === null) {
      throw new Error('Cannot rest a MARKET order on the book (must be filled or rejected)');
    }
    const side = order.side === 'BUY' ? this.bids : this.asks;
    side.push(order);
    side.sort((a, b) => {
      const priceDiff = order.side === 'BUY' ? b.price! - a.price! : a.price! - b.price!;
      if (priceDiff !== 0) return priceDiff;
      return a.timestamp - b.timestamp; // earlier timestamp wins at same price
    });
  }

  /** Removes a resting order by id from whichever side it's on. Returns null if not found. */
  removeOrder(orderId: string): RestingOrder | null {
    const removeFrom = (list: RestingOrder[]): RestingOrder | null => {
      const idx = list.findIndex((o) => o.id === orderId);
      if (idx === -1) return null;
      const [removed] = list.splice(idx, 1);
      return removed;
    };
    return removeFrom(this.bids) ?? removeFrom(this.asks);
  }

  /** Pop the top resting order on a side (used internally by the matching engine while consuming liquidity). */
  peekTop(side: 'BUY' | 'SELL'): RestingOrder | null {
    const list = side === 'BUY' ? this.bids : this.asks;
    return list[0] ?? null;
  }

  /** Reduce or remove the top order on a side after it has been (partially) filled. */
  consumeTop(side: 'BUY' | 'SELL', filledQty: number): void {
    const list = side === 'BUY' ? this.bids : this.asks;
    const top = list[0];
    if (!top) return;
    top.filledQuantity += filledQty;
    if (top.filledQuantity >= top.quantity) {
      list.shift();
    }
  }

  /** Aggregates individual resting orders into price levels for external consumption (e.g. the REST API). */
  toSnapshot(): BookSnapshot {
    const aggregate = (list: RestingOrder[]) => {
      const levels = new Map<number, { quantity: number; orderCount: number }>();
      for (const o of list) {
        const remaining = o.quantity - o.filledQuantity;
        const price = o.price!;
        const existing = levels.get(price) ?? { quantity: 0, orderCount: 0 };
        existing.quantity += remaining;
        existing.orderCount += 1;
        levels.set(price, existing);
      }
      return Array.from(levels.entries()).map(([price, v]) => ({ price, ...v }));
    };

    return {
      symbol: this.symbol,
      bids: aggregate(this.bids),
      asks: aggregate(this.asks),
    };
  }
}
