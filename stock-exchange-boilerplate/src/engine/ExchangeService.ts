import { OrderBook } from './OrderBook';
import { matchOrder } from './matchOrder';
import {
  IncomingOrder,
  MatchResult,
  OrderAcceptedEvent,
  TradeExecutedEvent,
  OrderCancelledEvent,
} from '../types/domain';
import { producer, TOPICS } from '../kafka/kafkaclient';

/**
 * In-memory registry of one OrderBook per symbol.
 * This is intentionally a single-process, single-instance service for now —
 * see Phase 6 in the roadmap for sharding this by symbol across processes.
 */
export class ExchangeService {
  private books = new Map<string, OrderBook>();

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
      console.error(`Failed to publish to ${topic}`, err);
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

    return removed;
  }

  /** Returns the current bid/ask levels for a symbol (empty book if never traded). */
  getSnapshot(symbol: string) {
    const book = this.books.get(symbol);
    if (!book) return { symbol, bids: [], asks: [] };
    return book.toSnapshot();
  }
}

// Singleton for this boilerplate. Swap for DI if the app grows.
export const exchangeService = new ExchangeService();
