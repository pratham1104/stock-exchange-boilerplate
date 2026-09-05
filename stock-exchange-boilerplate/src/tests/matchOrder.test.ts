import { describe, it, expect } from 'vitest';
import { OrderBook } from '../engine/OrderBook';
import { matchOrder } from '../engine/matchOrder';
import { IncomingOrder } from '../types/domain';

const baseOrder = (overrides: Partial<IncomingOrder>): IncomingOrder => ({
  id: overrides.id ?? Math.random().toString(36).slice(2),
  accountId: 'acct-1',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'LIMIT',
  price: 100,
  quantity: 10,
  timestamp: Date.now(),
  ...overrides,
});

describe('matchOrder', () => {
  it('rests on an empty book with no match', () => {
    const book = new OrderBook('AAPL');
    const order = baseOrder({ side: 'BUY', price: 100, quantity: 10 });

    const result = matchOrder(order, book);

    expect(result.trades).toHaveLength(0);
    expect(result.remainingOrder).not.toBeNull();
    expect(result.filledQuantity).toBe(0);
    expect(book.getBestBid()?.id).toBe(order.id);
  });

  it('fully fills a crossing limit order against a single resting order', () => {
    const book = new OrderBook('AAPL');
    const sellOrder = baseOrder({ id: 'sell-1', side: 'SELL', price: 100, quantity: 10 });
    matchOrder(sellOrder, book); // rests

    const buyOrder = baseOrder({ id: 'buy-1', side: 'BUY', price: 100, quantity: 10 });
    const result = matchOrder(buyOrder, book);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(10);
    expect(result.trades[0].price).toBe(100);
    expect(result.remainingOrder).toBeNull();
    expect(result.filledQuantity).toBe(10);
    expect(book.getBestAsk()).toBeNull(); // fully consumed
  });

  it('partially fills, leaving remainder resting on the book', () => {
    const book = new OrderBook('AAPL');
    const sellOrder = baseOrder({ id: 'sell-1', side: 'SELL', price: 100, quantity: 5 });
    matchOrder(sellOrder, book);

    const buyOrder = baseOrder({ id: 'buy-1', side: 'BUY', price: 100, quantity: 10 });
    const result = matchOrder(buyOrder, book);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(5);
    expect(result.remainingOrder?.quantity).toBe(10);
    expect(result.remainingOrder?.filledQuantity).toBe(5);
    expect(result.filledQuantity).toBe(5);
    // the maker was fully consumed
    expect(result.makerFills).toEqual([{ orderId: 'sell-1', totalQuantity: 5, filledQuantity: 5 }]);
    expect(book.getBestBid()?.id).toBe('buy-1'); // remainder now resting
  });

  it('reports maker fills so resting orders can be updated in the DB', () => {
    const book = new OrderBook('AAPL');
    matchOrder(baseOrder({ id: 'sell-a', side: 'SELL', price: 100, quantity: 4 }), book);
    matchOrder(baseOrder({ id: 'sell-b', side: 'SELL', price: 101, quantity: 10 }), book);

    const result = matchOrder(baseOrder({ id: 'buy-1', side: 'BUY', price: 101, quantity: 9 }), book);

    // sell-a fully filled (4), sell-b partially filled (5 of 10)
    expect(result.makerFills).toEqual([
      { orderId: 'sell-a', totalQuantity: 4, filledQuantity: 4 },
      { orderId: 'sell-b', totalQuantity: 10, filledQuantity: 5 },
    ]);
  });

  it('market order fully filled against one resting order: remainingOrder null AND filledQuantity == quantity', () => {
    const book = new OrderBook('AAPL');
    matchOrder(baseOrder({ id: 'sell-1', side: 'SELL', price: 101, quantity: 10 }), book);

    const marketBuy = baseOrder({ id: 'buy-1', side: 'BUY', type: 'MARKET', price: null, quantity: 10 });
    const result = matchOrder(marketBuy, book);

    expect(result.trades).toHaveLength(1);
    expect(result.remainingOrder).toBeNull();
    expect(result.filledQuantity).toBe(10);
  });

  it('market order partially fills and drops the unfilled remainder (remainingOrder null but filledQuantity < quantity)', () => {
    const book = new OrderBook('AAPL');
    matchOrder(baseOrder({ id: 'sell-1', side: 'SELL', price: 101, quantity: 3 }), book);

    const marketBuy = baseOrder({ id: 'buy-1', side: 'BUY', type: 'MARKET', price: null, quantity: 10 });
    const result = matchOrder(marketBuy, book);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(3);
    expect(result.trades[0].price).toBe(101);
    expect(result.remainingOrder).toBeNull(); // unfilled 7 qty dropped, does not rest
    // The caller cannot tell this apart from a full fill using remainingOrder alone —
    // this is exactly why MatchResult carries filledQuantity.
    expect(result.filledQuantity).toBe(3);
    expect(book.getBestAsk()).toBeNull();
  });

  it('market order against an empty book fills nothing and does not throw (remainingOrder null AND filledQuantity 0)', () => {
    const book = new OrderBook('AAPL');
    const marketBuy = baseOrder({ side: 'BUY', type: 'MARKET', price: null, quantity: 10 });

    const result = matchOrder(marketBuy, book);

    expect(result.trades).toHaveLength(0);
    expect(result.remainingOrder).toBeNull();
    expect(result.filledQuantity).toBe(0);
  });

  it('respects price-time priority: older order at the same price fills first', () => {
    const book = new OrderBook('AAPL');
    matchOrder(baseOrder({ id: 'sell-old', side: 'SELL', price: 100, quantity: 5, timestamp: 1 }), book);
    matchOrder(baseOrder({ id: 'sell-new', side: 'SELL', price: 100, quantity: 5, timestamp: 2 }), book);

    const buyOrder = baseOrder({ id: 'buy-1', side: 'BUY', price: 100, quantity: 5 });
    const result = matchOrder(buyOrder, book);

    expect(result.trades[0].sellOrderId).toBe('sell-old');
    expect(book.getBestAsk()?.id).toBe('sell-new'); // untouched, still resting
  });

  it('does not match when the incoming limit price does not cross the book', () => {
    const book = new OrderBook('AAPL');
    matchOrder(baseOrder({ id: 'sell-1', side: 'SELL', price: 105, quantity: 5 }), book);

    const buyOrder = baseOrder({ id: 'buy-1', side: 'BUY', price: 100, quantity: 5 });
    const result = matchOrder(buyOrder, book);

    expect(result.trades).toHaveLength(0);
    expect(result.remainingOrder).not.toBeNull();
    expect(result.filledQuantity).toBe(0);
    expect(book.getBestBid()?.id).toBe('buy-1');
  });

  it('cancel removes a resting order from the book', () => {
    const book = new OrderBook('AAPL');
    matchOrder(baseOrder({ id: 'buy-1', side: 'BUY', price: 100, quantity: 5 }), book);

    const removed = book.removeOrder('buy-1');

    expect(removed?.id).toBe('buy-1');
    expect(book.getBestBid()).toBeNull();
  });
});
