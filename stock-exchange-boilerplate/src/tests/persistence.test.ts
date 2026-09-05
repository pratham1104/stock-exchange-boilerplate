import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakePrisma } from './helpers/fakePrisma';
import {
  storedStatus,
  insertOrder,
  updateOrderFill,
  markOrderCancelled,
  insertTrade,
  writeAccountSnapshot,
} from '../db/persistence';
import type { IncomingOrder, Trade } from '../types/domain';

let db: ReturnType<typeof makeFakePrisma>;

beforeEach(() => {
  db = makeFakePrisma();
});

const order = (o: Partial<IncomingOrder> = {}): IncomingOrder => ({
  id: 'o1',
  accountId: 'acc',
  symbol: 'AAA',
  side: 'BUY',
  type: 'LIMIT',
  price: 10,
  quantity: 10,
  timestamp: Date.now(),
  ...o,
});

describe('storedStatus', () => {
  it('maps fill progress to a status', () => {
    expect(storedStatus({ quantity: 10, type: 'LIMIT' }, 0)).toBe('OPEN');
    expect(storedStatus({ quantity: 10, type: 'MARKET' }, 0)).toBe('REJECTED');
    expect(storedStatus({ quantity: 10, type: 'LIMIT' }, 4)).toBe('PARTIALLY_FILLED');
    expect(storedStatus({ quantity: 10, type: 'LIMIT' }, 10)).toBe('FILLED');
  });
});

describe('order persistence', () => {
  it('inserts, updates fills, and cancels', async () => {
    await insertOrder(db.client as never, order({ id: 'o1' }), 0, 'OPEN');
    expect(db.stores.orders.get('o1')).toMatchObject({ status: 'OPEN', filledQuantity: 0, accountId: 'acc' });

    await updateOrderFill(db.client as never, 'o1', 4, 'PARTIALLY_FILLED');
    expect(db.stores.orders.get('o1')).toMatchObject({ filledQuantity: 4, status: 'PARTIALLY_FILLED' });

    await markOrderCancelled(db.client as never, 'o1');
    expect(db.stores.orders.get('o1')).toMatchObject({ status: 'CANCELLED' });
  });
});

describe('insertTrade', () => {
  it('writes all trade columns including both account ids', async () => {
    const trade: Trade = {
      id: 't1',
      symbol: 'AAA',
      buyOrderId: 'b',
      sellOrderId: 's',
      buyAccountId: 'buyer',
      sellAccountId: 'seller',
      price: 12,
      quantity: 3,
      timestamp: Date.now(),
    };
    await insertTrade(db.client as never, trade);
    expect(db.stores.trades.get('t1')).toMatchObject({ buyAccountId: 'buyer', sellAccountId: 'seller', price: 12 });
  });
});

describe('writeAccountSnapshot', () => {
  it('upserts the account and replaces positions', async () => {
    await writeAccountSnapshot(db.client as never, {
      id: 'acc',
      name: 'alice',
      apiKeyHash: 'hash',
      cashBalance: 500,
      positions: [{ symbol: 'AAA', quantity: 5 }],
    });
    expect(db.stores.accounts.get('acc')).toMatchObject({ name: 'alice', apiKeyHash: 'hash', cashBalance: 500 });
    expect(db.stores.positions).toEqual([{ accountId: 'acc', symbol: 'AAA', quantity: 5 }]);

    await writeAccountSnapshot(db.client as never, {
      id: 'acc',
      name: 'alice',
      apiKeyHash: 'hash',
      cashBalance: 400,
      positions: [{ symbol: 'BBB', quantity: 1 }],
    });
    expect(db.stores.accounts.get('acc')).toMatchObject({ cashBalance: 400 });
    expect(db.stores.positions).toEqual([{ accountId: 'acc', symbol: 'BBB', quantity: 1 }]);
  });

  it('clears positions when the snapshot has none', async () => {
    await writeAccountSnapshot(db.client as never, {
      id: 'acc',
      name: 'a',
      apiKeyHash: 'h',
      cashBalance: 1,
      positions: [{ symbol: 'X', quantity: 1 }],
    });
    await writeAccountSnapshot(db.client as never, { id: 'acc', name: 'a', apiKeyHash: 'h', cashBalance: 1, positions: [] });
    expect(db.stores.positions).toEqual([]);
  });
});
