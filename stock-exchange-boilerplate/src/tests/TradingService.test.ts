import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingOrder } from '../types/domain';
import { makeFakePrisma } from './helpers/fakePrisma';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

const { ExchangeService } = await import('../engine/ExchangeService');
const { AccountService } = await import('../engine/AccountService');
const { TradingService } = await import('../engine/TradingService');
const { writeAccountSnapshot } = await import('../db/persistence');

let fake: ReturnType<typeof makeFakePrisma>;
let trading: InstanceType<typeof TradingService>;
let accounts: InstanceType<typeof AccountService>;
let buyerId = '';
let sellerId = '';
let seq = 0;
const oid = () => `o-${++seq}`;

const order = (accountId: string, o: Partial<IncomingOrder>): IncomingOrder => ({
  id: oid(),
  accountId,
  symbol: 'ZZ',
  side: 'BUY',
  type: 'LIMIT',
  price: 10,
  quantity: 10,
  timestamp: Date.now(),
  ...o,
});

async function fund(name: string, cash: number, shares?: number): Promise<string> {
  const { view } = accounts.createAccount(name, cash);
  if (shares) accounts.deposit(view.id, { symbol: 'ZZ', quantity: shares });
  await writeAccountSnapshot(fake.client as never, accounts.snapshot(view.id));
  return view.id;
}

beforeEach(async () => {
  fake = makeFakePrisma();
  accounts = new AccountService();
  trading = new TradingService(new ExchangeService(), accounts, fake.client as never);
  buyerId = await fund('buyer', 100_000);
  sellerId = await fund('seller', 0, 1000);
});

describe('TradingService.submitOrder', () => {
  it('rejects an unaffordable order without touching the book or the DB', async () => {
    const poor = await fund('poor', 5);
    const outcome = await trading.submitOrder(order(poor, { side: 'BUY', price: 10, quantity: 10 }));

    expect(outcome.status).toBe('rejected');
    expect(trading.getSnapshot('ZZ')).toMatchObject({ bids: [], asks: [] });
    expect(fake.stores.orders.size).toBe(0);
  });

  it('write-throughs a resting limit buy: order row + reserved cash + account row', async () => {
    const outcome = await trading.submitOrder(order(buyerId, { id: 'buy-rest', side: 'BUY', price: 10, quantity: 10 }));

    expect(outcome.status).toBe('accepted');
    expect(fake.stores.orders.get('buy-rest')).toMatchObject({ status: 'OPEN', filledQuantity: 0, accountId: buyerId });
    expect(accounts.getView(buyerId)).toMatchObject({ cashBalance: 99_900, reservedCash: 100 });
    expect(fake.stores.accounts.get(buyerId)).toMatchObject({ cashBalance: 100_000 }); // settled, gross
  });

  it('settles a crossing trade end to end and persists both sides', async () => {
    await trading.submitOrder(order(sellerId, { id: 'sell-x', side: 'SELL', price: 20, quantity: 5 }));
    const outcome = await trading.submitOrder(order(buyerId, { id: 'buy-x', side: 'BUY', price: 20, quantity: 5 }));

    expect(outcome.status).toBe('accepted');
    expect(fake.stores.trades.size).toBe(1);
    expect(fake.stores.orders.get('sell-x')).toMatchObject({ status: 'FILLED', filledQuantity: 5 });
    expect(fake.stores.orders.get('buy-x')).toMatchObject({ status: 'FILLED', filledQuantity: 5 });

    expect(accounts.getView(buyerId)).toMatchObject({ cashBalance: 100_000 - 100, positions: [{ symbol: 'ZZ', quantity: 5 }] });
    expect(fake.stores.accounts.get(sellerId)).toMatchObject({ cashBalance: 100 });
    expect(fake.stores.positions.find((p) => p.accountId === sellerId)).toMatchObject({ quantity: 995 });
  });

  it('records a no-liquidity market buy as REJECTED', async () => {
    const outcome = await trading.submitOrder(
      order(buyerId, { id: 'mkt', side: 'BUY', type: 'MARKET', price: null, quantity: 10 }),
    );
    expect(outcome.status).toBe('accepted');
    expect(fake.stores.orders.get('mkt')).toMatchObject({ status: 'REJECTED', filledQuantity: 0 });
    expect(accounts.getView(buyerId).reservedCash).toBe(0);
  });

  it('marks the service degraded and returns error when the write-through fails', async () => {
    fake.client.$transaction = vi.fn().mockRejectedValue(new Error('db down'));

    const outcome = await trading.submitOrder(order(buyerId, { side: 'BUY', price: 10, quantity: 1 }));

    expect(outcome.status).toBe('error');
    expect(trading.isDegraded()).toBe(true);
  });

  it('serializes concurrent submissions on the same symbol', async () => {
    const seen: string[] = [];
    const orig = accounts.settleTrade.bind(accounts);
    vi.spyOn(accounts, 'settleTrade').mockImplementation((t) => {
      seen.push('settle-start');
      orig(t);
      seen.push('settle-end');
    });

    await trading.submitOrder(order(sellerId, { side: 'SELL', price: 5, quantity: 100 }));
    await Promise.all([
      trading.submitOrder(order(buyerId, { side: 'BUY', price: 5, quantity: 10 })),
      trading.submitOrder(order(buyerId, { side: 'BUY', price: 5, quantity: 10 })),
    ]);

    // If interleaved we'd see start,start,end,end somewhere; serialized => strictly paired.
    for (let i = 0; i < seen.length; i += 2) {
      expect(seen[i]).toBe('settle-start');
      expect(seen[i + 1]).toBe('settle-end');
    }
  });
});

describe('TradingService.cancelOrder', () => {
  it('cancels, frees the reservation, persists, and enforces ownership', async () => {
    const placed = await trading.submitOrder(order(buyerId, { id: 'to-cancel', side: 'BUY', price: 10, quantity: 10 }));
    if (placed.status !== 'accepted') throw new Error('setup');

    expect(await trading.cancelOrder('ZZ', 'ghost', buyerId)).toEqual({ status: 'not_found' });
    expect((await trading.cancelOrder('ZZ', 'to-cancel', sellerId)).status).toBe('forbidden');

    const ok = await trading.cancelOrder('ZZ', 'to-cancel', buyerId);
    expect(ok.status).toBe('cancelled');
    expect(fake.stores.orders.get('to-cancel')).toMatchObject({ status: 'CANCELLED' });
    expect(accounts.getView(buyerId)).toMatchObject({ cashBalance: 100_000, reservedCash: 0 });
  });
});
