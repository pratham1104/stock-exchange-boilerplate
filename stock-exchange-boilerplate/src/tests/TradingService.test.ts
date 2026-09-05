import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingOrder } from '../types/domain';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: {
    ORDER_ACCEPTED: 'order.accepted',
    TRADE_EXECUTED: 'trade.executed',
    ORDER_CANCELLED: 'order.cancelled',
    ACCOUNT_UPDATED: 'account.updated',
  },
}));

const { ExchangeService } = await import('../engine/ExchangeService');
const { AccountService } = await import('../engine/AccountService');
const { TradingService } = await import('../engine/TradingService');

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

beforeEach(async () => {
  accounts = new AccountService();
  trading = new TradingService(new ExchangeService(), accounts);
  buyerId = (await accounts.createAccount('buyer', 100_000)).view.id;
  sellerId = (await accounts.createAccount('seller', 0)).view.id;
  await accounts.deposit(sellerId, { symbol: 'ZZ', quantity: 1000 });
});

describe('TradingService.submitOrder', () => {
  it('rejects an unaffordable order without touching the book', async () => {
    const poor = (await accounts.createAccount('poor', 5)).view.id;

    const outcome = await trading.submitOrder(order(poor, { side: 'BUY', price: 10, quantity: 10 }));

    expect(outcome.status).toBe('rejected');
    expect(trading.getSnapshot('ZZ')).toMatchObject({ bids: [], asks: [] });
  });

  it('rests an unmatched limit buy and reserves its cost', async () => {
    const outcome = await trading.submitOrder(order(buyerId, { side: 'BUY', price: 10, quantity: 10 }));

    expect(outcome.status).toBe('accepted');
    expect(accounts.getView(buyerId)).toMatchObject({ cashBalance: 99_900, reservedCash: 100 });
    expect(trading.getSnapshot('ZZ').bids).toHaveLength(1);
  });

  it('settles a crossing trade end to end', async () => {
    await trading.submitOrder(order(sellerId, { side: 'SELL', price: 20, quantity: 5 }));
    const outcome = await trading.submitOrder(order(buyerId, { side: 'BUY', price: 20, quantity: 5 }));

    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;
    expect(outcome.result.trades).toHaveLength(1);

    expect(accounts.getView(buyerId)).toMatchObject({
      cashBalance: 100_000 - 100,
      reservedCash: 0,
      positions: [{ symbol: 'ZZ', quantity: 5 }],
    });
    expect(accounts.getView(sellerId)).toMatchObject({ cashBalance: 100, reservedCash: 0 });
    expect(accounts.getView(sellerId).positions[0].quantity).toBe(995);
  });

  it('reserves, matches, and returns unused reservation for a partially-filled market buy', async () => {
    // Only 3 shares available @ 30.
    await trading.submitOrder(order(sellerId, { side: 'SELL', price: 30, quantity: 3 }));

    const outcome = await trading.submitOrder(
      order(buyerId, { side: 'BUY', type: 'MARKET', price: null, quantity: 10 }),
    );

    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;
    expect(outcome.result.filledQuantity).toBe(3);

    const view = accounts.getView(buyerId);
    expect(view.reservedCash).toBe(0); // market order never rests → nothing stays reserved
    expect(view.cashBalance).toBe(100_000 - 90); // only paid for the 3 it got
    expect(view.positions).toEqual([{ symbol: 'ZZ', quantity: 3 }]);
  });

  it('rejects a market buy the account cannot fully cover', async () => {
    await trading.submitOrder(order(sellerId, { side: 'SELL', price: 100, quantity: 10 }));
    const broke = (await accounts.createAccount('broke', 150)).view.id;

    const outcome = await trading.submitOrder(
      order(broke, { side: 'BUY', type: 'MARKET', price: null, quantity: 10 }),
    );

    expect(outcome.status).toBe('rejected');
  });
});

describe('TradingService.cancelOrder', () => {
  it('cancels, frees the reservation, and reports not_found / forbidden correctly', async () => {
    const placed = await trading.submitOrder(order(buyerId, { side: 'BUY', price: 10, quantity: 10 }));
    if (placed.status !== 'accepted') throw new Error('setup');
    const orderId = placed.result.remainingOrder!.id;

    expect(await trading.cancelOrder('ZZ', 'ghost', buyerId)).toEqual({ status: 'not_found' });
    expect(await trading.cancelOrder('ZZ', orderId, sellerId)).toEqual({ status: 'forbidden' });

    const ok = await trading.cancelOrder('ZZ', orderId, buyerId);
    expect(ok.status).toBe('cancelled');
    expect(accounts.getView(buyerId)).toMatchObject({ cashBalance: 100_000, reservedCash: 0 });
  });
});
