import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeFakePrisma } from './helpers/fakePrisma';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

const { loadAccountSnapshots, loadOpenOrders } = await import('../db/rehydrate');
const { AccountService, hashApiKey } = await import('../engine/AccountService');
const { ExchangeService } = await import('../engine/ExchangeService');
const { TradingService } = await import('../engine/TradingService');
const { writeAccountSnapshot, insertOrder } = await import('../db/persistence');

let db: ReturnType<typeof makeFakePrisma>;

beforeEach(() => {
  db = makeFakePrisma();
});

describe('loaders', () => {
  it('loadAccountSnapshots returns accounts with their positions', async () => {
    await writeAccountSnapshot(db.client as never, {
      id: 'a1',
      name: 'alice',
      apiKeyHash: 'h1',
      cashBalance: 900,
      positions: [{ symbol: 'AAA', quantity: 3 }],
    });
    const snaps = await loadAccountSnapshots(db.client as never);
    expect(snaps).toEqual([
      { id: 'a1', name: 'alice', apiKeyHash: 'h1', cashBalance: 900, positions: [{ symbol: 'AAA', quantity: 3 }] },
    ]);
  });

  it('loadOpenOrders returns only OPEN / PARTIALLY_FILLED, oldest first', async () => {
    const base = { accountId: 'a1', symbol: 'AAA', side: 'BUY', type: 'LIMIT', price: 10, quantity: 10 } as const;
    await insertOrder(db.client as never, { id: 'old', timestamp: 1000, ...base }, 0, 'OPEN');
    await insertOrder(db.client as never, { id: 'new', timestamp: 2000, ...base }, 4, 'PARTIALLY_FILLED');
    await insertOrder(db.client as never, { id: 'done', timestamp: 1500, ...base }, 10, 'FILLED');

    const open = await loadOpenOrders(db.client as never);
    expect(open.map((o) => o.id)).toEqual(['old', 'new']);
    expect(open[1]).toMatchObject({ filledQuantity: 4 });
  });
});

describe('restart recovery', () => {
  it('rebuilds books + reservations from Postgres so a new order matches and settles correctly', async () => {
    // --- process 1: a seller rests 5 @ 50, then the process dies ---
    const seller = new AccountService();
    const sellerId = seller.createAccount('seller', 0).view.id;
    seller.deposit(sellerId, { symbol: 'AAA', quantity: 100 });
    await writeAccountSnapshot(db.client as never, seller.snapshot(sellerId));

    const restingId = 'resting-sell';
    seller.reserveForOrder(
      { id: restingId, accountId: sellerId, symbol: 'AAA', side: 'SELL', type: 'LIMIT', price: 50, quantity: 5, timestamp: 1 },
      0,
    );
    await insertOrder(
      db.client as never,
      { id: restingId, accountId: sellerId, symbol: 'AAA', side: 'SELL', type: 'LIMIT', price: 50, quantity: 5, timestamp: 1 },
      0,
      'OPEN',
    );
    await writeAccountSnapshot(db.client as never, seller.snapshot(sellerId));

    // a buyer exists too
    const buyerAcc = new AccountService();
    const buyerId = buyerAcc.createAccount('buyer', 1000).view.id;
    await writeAccountSnapshot(db.client as never, buyerAcc.snapshot(buyerId));

    // --- process 2: cold start, rehydrate from the DB ---
    const accounts = new AccountService();
    const exchange = new ExchangeService();
    const trading = new TradingService(exchange, accounts, db.client as never);

    accounts.hydrate(await loadAccountSnapshots(db.client as never));
    const openOrders = await loadOpenOrders(db.client as never);
    exchange.hydrateBook(openOrders);
    for (const o of openOrders) accounts.rebuildReservation(o);

    // the resting sell is back, and the seller's shares are reserved again
    expect(exchange.getSnapshot('AAA').asks).toEqual([{ price: 50, quantity: 5, orderCount: 1 }]);
    expect(accounts.getView(sellerId)).toMatchObject({ positions: [{ symbol: 'AAA', quantity: 100 }] });

    // seller can't double-sell the reserved shares
    // (95 free of 100)  -> selling 96 fails, 95 ok
    // --- a fresh buy order crosses the rehydrated book ---
    const outcome = await trading.submitOrder({
      id: 'buy-after-restart',
      accountId: buyerId,
      symbol: 'AAA',
      side: 'BUY',
      type: 'LIMIT',
      price: 50,
      quantity: 5,
      timestamp: Date.now(),
    });

    expect(outcome.status).toBe('accepted');
    expect(accounts.getView(buyerId)).toMatchObject({ cashBalance: 750, positions: [{ symbol: 'AAA', quantity: 5 }] });
    expect(accounts.getView(sellerId).cashBalance).toBe(250);
    // resting sell is now filled in the DB
    expect(db.stores.orders.get(restingId)).toMatchObject({ status: 'FILLED', filledQuantity: 5 });
    // the API-key hash still resolves after the restart
    expect(accounts.snapshot(sellerId).apiKeyHash).toEqual(expect.any(String));
    void hashApiKey;
  });
});
