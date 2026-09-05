import { EventEmitter } from 'events';
import { OrderBook } from './OrderBook';
import { matchOrder } from './matchOrder';
import {
  IncomingOrder,
  MatchResult,
  OrderAcceptedEvent,
  TradeExecutedEvent,
  OrderCancelledEvent,
  RestingOrder,
  Trade,
  BookSnapshot,
} from '../types/domain';
import { producer, TOPICS } from '../kafka/kafkaclient';
import { logger } from '../logger';

/** Typed events ExchangeService emits for in-process consumers (e.g. the WebSocket market-data layer). */
export interface ExchangeServiceEvents {
  trade: (trade: Trade) => void;
  book: (symbol: string, snapshot: BookSnapshot) => void;
}

/**
 * In-memory registry of one OrderBook per symbol.
 * This is intentionally a single-process, single-instance service for now —
 * see Phase 6 in the roadmap for sharding this by symbol across processes.
 *
 * Also an EventEmitter: emits 'trade' (once per trade) and 'book' (once per
 * symbol whose book changed) after every submit/cancel, so same-process
 * consumers like the market-data WebSocket layer don't have to round-trip
 * through Kafka to see fresh state. This is separate from and in addition to
 * the Kafka publish below — Kafka is the durable audit log, this is a live
 * fan-out fast path.
 */
export class ExchangeService extends EventEmitter {
  private books = new Map<string, OrderBook>();

  // Narrow EventEmitter's untyped on/emit to ExchangeServiceEvents for these two call sites.
  on<K extends keyof ExchangeServiceEvents>(event: K, listener: ExchangeServiceEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof ExchangeServiceEvents>(event: K, ...args: Parameters<ExchangeServiceEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Lazily creates a book the first time a symbol is traded. */
  private getOrCreateBook(symbol: string): OrderBook {
    let book = this.books.get(symbol);
    if (!book) {
      book = new OrderBook(symbol);
      this.books.set(symbol, book);
    }
    return book;
  }

  /**
   * Publishing is best-effort: a Kafka outage shouldn't stop the matching
   * engine from accepting/cancelling orders, so failures are logged and
   * swallowed rather than propagated to the caller.
   */
  private async publish(topic: string, messages: { key: string; value: string }[]): Promise<void> {
    try {
      await producer.send({ topic, messages });
    } catch (err) {
      logger.error({ err, topic }, 'Failed to publish to Kafka');
    }
  }

  /**
   * Rebuild books from orders that were resting when the process last stopped
   * (loaded from Postgres on startup, oldest first). No matching, no events —
   * just re-seat the resting orders in time priority.
   */
  hydrateBook(restingOrders: RestingOrder[]): void {
    for (const order of restingOrders) {
      this.getOrCreateBook(order.symbol).addOrder(order);
    }
  }

  /**
   * Runs an incoming order through the matching engine for its symbol's book,
   * then publishes an OrderAccepted event and one TradeExecuted event per
   * resulting trade.
   */
  async submitOrder(order: IncomingOrder): Promise<MatchResult> {
    const book = this.getOrCreateBook(order.symbol);
    const result = matchOrder(order, book);

    const accepted: OrderAcceptedEvent = { type: 'OrderAccepted', order };
    await this.publish(TOPICS.ORDER_ACCEPTED, [
      {
        // Keying by orderId ensures all events for the same order land on
        // the same partition -> preserves per-order ordering guarantees.
        key: order.id,
        value: JSON.stringify(accepted),
      },
    ]);

    if (result.trades.length > 0) {
      await this.publish(
        TOPICS.TRADE_EXECUTED,
        result.trades.map((trade) => {
          const executed: TradeExecutedEvent = { type: 'TradeExecuted', trade };
          return { key: trade.id, value: JSON.stringify(executed) };
        }),
      );
    }

    for (const trade of result.trades) this.emit('trade', trade);
    // Emit the fresh snapshot whenever the book could have changed: a trade
    // consumed liquidity, or the order itself started resting.
    if (result.trades.length > 0 || result.remainingOrder) {
      this.emit('book', order.symbol, this.getSnapshot(order.symbol));
    }

    return result;
  }

  /** Cancels a resting order and publishes OrderCancelled on success. Returns null if the symbol/order doesn't exist. */
  async cancelOrder(symbol: string, orderId: string) {
    const book = this.books.get(symbol);
    if (!book) return null;

    const removed = book.removeOrder(orderId);
    if (!removed) return null;

    const cancelled: OrderCancelledEvent = { type: 'OrderCancelled', orderId: removed.id, symbol };
    await this.publish(TOPICS.ORDER_CANCELLED, [{ key: removed.id, value: JSON.stringify(cancelled) }]);

    this.emit('book', symbol, this.getSnapshot(symbol));

    return removed;
  }

  /** Returns the current bid/ask levels for a symbol (empty book if never traded). */
  getSnapshot(symbol: string) {
    const book = this.books.get(symbol);
    if (!book) return { symbol, bids: [], asks: [] };
    return book.toSnapshot();
  }

  /**
   * Cost to buy `quantity` right now by sweeping the ask side, plus how much is
   * actually fillable. Used to size the cash reservation for a MARKET buy.
   */
  estimateBuyCost(symbol: string, quantity: number): { cost: number; fillable: number } {
    const book = this.books.get(symbol);
    return book ? book.estimateBuyCost(quantity) : { cost: 0, fillable: 0 };
  }
}

// Singleton for this boilerplate. Swap for DI if the app grows.
export const exchangeService = new ExchangeService();
