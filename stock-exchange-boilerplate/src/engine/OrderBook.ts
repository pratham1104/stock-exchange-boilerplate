import { RestingOrder, BookSnapshot } from '../types/domain';

type Side = 'BUY' | 'SELL';

interface PriceLevel {
  price: number;
  orders: RestingOrder[]; // FIFO within a level — arrival order == time priority
}

/**
 * One side of the book: a price-ordered array of price levels, each holding a
 * FIFO queue of orders. Levels are kept sorted by inserting new ones at the
 * right spot (binary search + splice) rather than re-sorting the whole side,
 * so adding an order is O(log L) to find the level + O(L) worst case to splice
 * in a brand-new level (L = distinct price levels, typically small and reused),
 * vs. the old O(N log N) sort of every resting order on every insert.
 *
 * For very deep books a balanced tree keyed by price would drop the splice
 * cost too; buckets-in-an-array is the pragmatic middle ground (Phase 6).
 */
class BookSide {
  readonly levels: PriceLevel[] = [];

  constructor(private readonly direction: Side) {}

  /** True if price `a` has strictly higher priority than price `b` on this side. */
  private isBetter(a: number, b: number): boolean {
    return this.direction === 'BUY' ? a > b : a < b;
  }

  /** Binary search: exact level if `found`, otherwise the index to splice a new one in at. */
  private locate(price: number): { found: boolean; index: number } {
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midPrice = this.levels[mid].price;
      if (midPrice === price) return { found: true, index: mid };
      if (this.isBetter(midPrice, price)) lo = mid + 1;
      else hi = mid;
    }
    return { found: false, index: lo };
  }

  add(order: RestingOrder): void {
    const price = order.price as number;
    const { found, index } = this.locate(price);
    if (found) this.levels[index].orders.push(order);
    else this.levels.splice(index, 0, { price, orders: [order] });
  }

  best(): RestingOrder | null {
    return this.levels[0]?.orders[0] ?? null;
  }

  /** Adds `filledQty` to the top order's fill, dropping it (and an emptied level) once complete. */
  consumeBest(filledQty: number): void {
    const level = this.levels[0];
    if (!level) return;
    const top = level.orders[0];
    top.filledQuantity += filledQty;
    if (top.filledQuantity >= top.quantity) {
      level.orders.shift();
      if (level.orders.length === 0) this.levels.shift();
    }
  }

  remove(orderId: string): RestingOrder | null {
    for (let i = 0; i < this.levels.length; i++) {
      const { orders } = this.levels[i];
      const j = orders.findIndex((o) => o.id === orderId);
      if (j === -1) continue;
      const [removed] = orders.splice(j, 1);
      if (orders.length === 0) this.levels.splice(i, 1);
      return removed;
    }
    return null;
  }

  /** All resting orders flattened into strict priority order (best price first, then FIFO). */
  ordersInPriority(): RestingOrder[] {
    return this.levels.flatMap((l) => l.orders);
  }

  aggregate(): Array<{ price: number; quantity: number; orderCount: number }> {
    return this.levels.map((level) => ({
      price: level.price,
      quantity: level.orders.reduce((sum, o) => sum + (o.quantity - o.filledQuantity), 0),
      orderCount: level.orders.length,
    }));
  }
}

/**
 * Single-symbol order book.
 * Bids ordered best-first (highest price). Asks ordered best-first (lowest price).
 * Within a price level, orders are FIFO by arrival (price-time priority).
 */
export class OrderBook {
  readonly symbol: string;
  private bids = new BookSide('BUY');
  private asks = new BookSide('SELL');

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  private sideFor(side: Side): BookSide {
    return side === 'BUY' ? this.bids : this.asks;
  }

  /** Highest-priority resting buy order, or null if the bid side is empty. */
  getBestBid(): RestingOrder | null {
    return this.bids.best();
  }

  /** Highest-priority resting sell order, or null if the ask side is empty. */
  getBestAsk(): RestingOrder | null {
    return this.asks.best();
  }

  /** Full bid side in priority order, read-only (for snapshotting/inspection). */
  getBidsRaw(): readonly RestingOrder[] {
    return this.bids.ordersInPriority();
  }

  /** Full ask side in priority order, read-only (for snapshotting/inspection). */
  getAsksRaw(): readonly RestingOrder[] {
    return this.asks.ordersInPriority();
  }

  /** Insert a resting (unfilled or partially filled) order into the correct side. */
  addOrder(order: RestingOrder): void {
    if (order.price === null) {
      throw new Error('Cannot rest a MARKET order on the book (must be filled or rejected)');
    }
    this.sideFor(order.side).add(order);
  }

  /** Removes a resting order by id from whichever side it's on. Returns null if not found. */
  removeOrder(orderId: string): RestingOrder | null {
    return this.bids.remove(orderId) ?? this.asks.remove(orderId);
  }

  /** Top resting order on a side (used by the matching engine while consuming liquidity). */
  peekTop(side: Side): RestingOrder | null {
    return this.sideFor(side).best();
  }

  /** Reduce or remove the top order on a side after it has been (partially) filled. */
  consumeTop(side: Side, filledQty: number): void {
    this.sideFor(side).consumeBest(filledQty);
  }

  /**
   * Cost to buy `quantity` by sweeping the ask side from the top, and how much
   * of `quantity` is actually fillable given current liquidity. Used to size the
   * cash reservation for a MARKET buy, which has no limit price to reserve against.
   */
  estimateBuyCost(quantity: number): { cost: number; fillable: number } {
    let remaining = quantity;
    let cost = 0;
    for (const level of this.asks.levels) {
      if (remaining <= 0) break;
      for (const order of level.orders) {
        const available = order.quantity - order.filledQuantity;
        const take = Math.min(remaining, available);
        cost += take * level.price;
        remaining -= take;
        if (remaining <= 0) break;
      }
    }
    return { cost, fillable: quantity - remaining };
  }

  /** Aggregates resting orders into price levels for external consumption (e.g. the REST API). */
  toSnapshot(): BookSnapshot {
    return {
      symbol: this.symbol,
      bids: this.bids.aggregate(),
      asks: this.asks.aggregate(),
    };
  }
}
