import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingOrder, Trade } from '../types/domain';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: { ACCOUNT_UPDATED: 'account.updated' },
}));

const { AccountService, InsufficientFundsError } = await import('../engine/AccountService');

let svc: InstanceType<typeof AccountService>;

const order = (o: Partial<IncomingOrder>): IncomingOrder => ({
  id: 'o1',
  accountId: 'a',
  symbol: 'ABC',
  side: 'BUY',
  type: 'LIMIT',
  price: 10,
  quantity: 10,
  timestamp: Date.now(),
  ...o,
});

const trade = (t: Partial<Trade>): Trade => ({
  id: 't1',
  symbol: 'ABC',
  buyOrderId: 'buy',
  sellOrderId: 'sell',
  buyAccountId: 'buyer',
  sellAccountId: 'seller',
  price: 10,
  quantity: 10,
  timestamp: Date.now(),
  ...t,
});

beforeEach(() => {
  svc = new AccountService();
});

describe('account lifecycle', () => {
  it('creates an account with a resolvable API key and starting cash', async () => {
    const { view, apiKey } = await svc.createAccount('alice', 500);
    expect(view).toMatchObject({ name: 'alice', cashBalance: 500, reservedCash: 0, positions: [] });
    expect(svc.resolveApiKey(apiKey)).toBe(view.id);
    expect(svc.resolveApiKey('nope')).toBeNull();
  });

  it('deposits cash and shares', async () => {
    const { view } = await svc.createAccount('bob', 0);
    await svc.deposit(view.id, { cash: 100 });
    await svc.deposit(view.id, { symbol: 'ABC', quantity: 7 });
    expect(svc.getView(view.id)).toMatchObject({ cashBalance: 100, positions: [{ symbol: 'ABC', quantity: 7 }] });
  });
});

describe('BUY reservations', () => {
  it('moves limit-order cost from available to reserved, and back on release', async () => {
    const { view } = await svc.createAccount('a', 1000);

    svc.reserveForOrder(order({ id: 'o1', accountId: view.id, side: 'BUY', price: 10, quantity: 10 }), 0);
    expect(svc.getView(view.id)).toMatchObject({ cashBalance: 900, reservedCash: 100 });

    svc.releaseOrder('o1');
    expect(svc.getView(view.id)).toMatchObject({ cashBalance: 1000, reservedCash: 0 });
  });

  it('rejects a buy the account cannot cover', async () => {
    const { view } = await svc.createAccount('a', 50);
    expect(() =>
      svc.reserveForOrder(order({ accountId: view.id, side: 'BUY', price: 10, quantity: 10 }), 0),
    ).toThrow(InsufficientFundsError);
    expect(svc.getView(view.id)).toMatchObject({ cashBalance: 50, reservedCash: 0 });
  });

  it('uses the estimated cost for a MARKET buy', async () => {
    const { view } = await svc.createAccount('a', 1000);
    svc.reserveForOrder(order({ id: 'm1', accountId: view.id, side: 'BUY', type: 'MARKET', price: null, quantity: 10 }), 340);
    expect(svc.getView(view.id)).toMatchObject({ cashBalance: 660, reservedCash: 340 });
  });
});

describe('SELL reservations', () => {
  it('holds shares and rejects a sell exceeding the free balance', async () => {
    const { view } = await svc.createAccount('a', 0);
    await svc.deposit(view.id, { symbol: 'ABC', quantity: 10 });

    svc.reserveForOrder(order({ id: 's1', accountId: view.id, side: 'SELL', price: 10, quantity: 6 }), 0);
    expect(() =>
      svc.reserveForOrder(order({ id: 's2', accountId: view.id, side: 'SELL', price: 10, quantity: 6 }), 0),
    ).toThrow(InsufficientFundsError);

    svc.releaseOrder('s1');
    // now the full 10 is free again
    svc.reserveForOrder(order({ id: 's3', accountId: view.id, side: 'SELL', price: 10, quantity: 10 }), 0);
  });
});

describe('settlement', () => {
  it('transfers cash and shares between two accounts on a fill', async () => {
    const buyer = (await svc.createAccount('buyer', 1000)).view;
    const seller = (await svc.createAccount('seller', 0)).view;
    await svc.deposit(seller.id, { symbol: 'ABC', quantity: 10 });

    svc.reserveForOrder(order({ id: 'buy', accountId: buyer.id, side: 'BUY', price: 10, quantity: 10 }), 0);
    svc.reserveForOrder(order({ id: 'sell', accountId: seller.id, side: 'SELL', price: 10, quantity: 10 }), 0);

    svc.settleTrade(trade({ buyOrderId: 'buy', sellOrderId: 'sell', buyAccountId: buyer.id, sellAccountId: seller.id, price: 10, quantity: 10 }));
    svc.finalizeOrder('buy', 0);
    svc.finalizeOrder('sell', 0);

    expect(svc.getView(buyer.id)).toMatchObject({ cashBalance: 900, reservedCash: 0, positions: [{ symbol: 'ABC', quantity: 10 }] });
    expect(svc.getView(seller.id)).toMatchObject({ cashBalance: 100, reservedCash: 0, positions: [] });
  });

  it('refunds the buyer when the fill price beats their limit', async () => {
    const buyer = (await svc.createAccount('buyer', 1000)).view;
    const seller = (await svc.createAccount('seller', 0)).view;
    await svc.deposit(seller.id, { symbol: 'ABC', quantity: 10 });

    // Buyer bid 10, fill happens at 8 → 20 refunded.
    svc.reserveForOrder(order({ id: 'buy', accountId: buyer.id, side: 'BUY', price: 10, quantity: 10 }), 0);
    svc.reserveForOrder(order({ id: 'sell', accountId: seller.id, side: 'SELL', price: 8, quantity: 10 }), 0);

    svc.settleTrade(trade({ buyOrderId: 'buy', sellOrderId: 'sell', buyAccountId: buyer.id, sellAccountId: seller.id, price: 8, quantity: 10 }));
    svc.finalizeOrder('buy', 0);

    expect(svc.getView(buyer.id).cashBalance).toBe(920); // 1000 - 8*10
    expect(svc.getView(buyer.id).reservedCash).toBe(0);
  });

  it('keeps a proportional reservation for the resting remainder of a partially filled buy', async () => {
    const buyer = (await svc.createAccount('buyer', 1000)).view;
    const seller = (await svc.createAccount('seller', 0)).view;
    await svc.deposit(seller.id, { symbol: 'ABC', quantity: 4 });

    svc.reserveForOrder(order({ id: 'buy', accountId: buyer.id, side: 'BUY', price: 10, quantity: 10 }), 0);
    svc.reserveForOrder(order({ id: 'sell', accountId: seller.id, side: 'SELL', price: 10, quantity: 4 }), 0);

    svc.settleTrade(trade({ buyOrderId: 'buy', sellOrderId: 'sell', buyAccountId: buyer.id, sellAccountId: seller.id, price: 10, quantity: 4 }));
    svc.finalizeOrder('buy', 6); // 6 still resting

    // 100 total reserved, 40 spent on the fill, 60 still held for the resting 6 @ 10.
    expect(svc.getView(buyer.id)).toMatchObject({ cashBalance: 900, reservedCash: 60 });
  });
});
