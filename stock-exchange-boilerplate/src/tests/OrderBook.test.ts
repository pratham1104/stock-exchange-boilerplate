import { describe, it, expect } from 'vitest';
import { OrderBook } from '../engine/OrderBook';
import type { RestingOrder } from '../types/domain';

let seq = 0;
const resting = (o: Partial<RestingOrder>): RestingOrder => ({
  id: `o-${++seq}`,
  accountId: 'a',
  symbol: 'ABC',
  side: 'BUY',
  type: 'LIMIT',
  price: 100,
  quantity: 10,
  filledQuantity: 0,
  timestamp: ++seq,
  ...o,
});

describe('OrderBook price-level structure', () => {
  it('orders bids best-first (highest price) and asks best-first (lowest price)', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ side: 'BUY', price: 100 }));
    book.addOrder(resting({ side: 'BUY', price: 105 }));
    book.addOrder(resting({ side: 'BUY', price: 95 }));
    book.addOrder(resting({ side: 'SELL', price: 110 }));
    book.addOrder(resting({ side: 'SELL', price: 108 }));

    expect(book.getBestBid()?.price).toBe(105);
    expect(book.getBestAsk()?.price).toBe(108);
    expect(book.getBidsRaw().map((o) => o.price)).toEqual([105, 100, 95]);
    expect(book.getAsksRaw().map((o) => o.price)).toEqual([108, 110]);
  });

  it('keeps FIFO order within a price level', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ id: 'first', side: 'BUY', price: 100 }));
    book.addOrder(resting({ id: 'second', side: 'BUY', price: 100 }));
    book.addOrder(resting({ id: 'third', side: 'BUY', price: 100 }));

    expect(book.getBidsRaw().map((o) => o.id)).toEqual(['first', 'second', 'third']);
  });

  it('drops a fully consumed order and then its emptied level', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ id: 'a', side: 'SELL', price: 100, quantity: 5 }));
    book.addOrder(resting({ id: 'b', side: 'SELL', price: 101, quantity: 5 }));

    book.consumeTop('SELL', 5);
    expect(book.getBestAsk()?.id).toBe('b');
    expect(book.toSnapshot().asks).toEqual([{ price: 101, quantity: 5, orderCount: 1 }]);
  });

  it('removeOrder pulls from the right level and cleans up an emptied one', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ id: 'keep', side: 'BUY', price: 100 }));
    book.addOrder(resting({ id: 'drop', side: 'BUY', price: 99 }));

    expect(book.removeOrder('drop')?.id).toBe('drop');
    expect(book.removeOrder('drop')).toBeNull();
    expect(book.getBidsRaw().map((o) => o.id)).toEqual(['keep']);
  });

  it('aggregates a level with multiple orders in toSnapshot', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ side: 'BUY', price: 100, quantity: 10, filledQuantity: 2 }));
    book.addOrder(resting({ side: 'BUY', price: 100, quantity: 5 }));

    expect(book.toSnapshot().bids).toEqual([{ price: 100, quantity: 13, orderCount: 2 }]);
  });
});

describe('OrderBook.estimateBuyCost', () => {
  it('sweeps the ask side and reports cost + fillable quantity', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ side: 'SELL', price: 10, quantity: 3 }));
    book.addOrder(resting({ side: 'SELL', price: 12, quantity: 4 }));
    book.addOrder(resting({ side: 'SELL', price: 15, quantity: 100 }));

    expect(book.estimateBuyCost(5)).toEqual({ cost: 3 * 10 + 2 * 12, fillable: 5 });
    expect(book.estimateBuyCost(7)).toEqual({ cost: 3 * 10 + 4 * 12, fillable: 7 });
  });

  it('caps fillable at available liquidity', () => {
    const book = new OrderBook('ABC');
    book.addOrder(resting({ side: 'SELL', price: 10, quantity: 3 }));

    expect(book.estimateBuyCost(10)).toEqual({ cost: 30, fillable: 3 });
  });

  it('returns zero on an empty ask side', () => {
    expect(new OrderBook('ABC').estimateBuyCost(5)).toEqual({ cost: 0, fillable: 0 });
  });
});
