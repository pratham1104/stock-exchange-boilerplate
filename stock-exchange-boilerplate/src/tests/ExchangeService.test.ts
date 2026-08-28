import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncomingOrder } from '../types/domain';

const send = vi.fn().mockResolvedValue(undefined);

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send },
  TOPICS: {
    ORDER_ACCEPTED: 'order.accepted',
    TRADE_EXECUTED: 'trade.executed',
    ORDER_CANCELLED: 'order.cancelled',
  },
}));

const { ExchangeService } = await import('../engine/ExchangeService');

const baseOrder = (overrides: Partial<IncomingOrder>): IncomingOrder => ({
  id: overrides.id ?? Math.random().toString(36).slice(2),
  symbol: 'AAPL',
  side: 'BUY',
  type: 'LIMIT',
  price: 100,
  quantity: 10,
  timestamp: Date.now(),
  ...overrides,
});

describe('ExchangeService event publishing', () => {
  beforeEach(() => {
    send.mockClear();
  });

  it('publishes OrderAccepted when an order rests with no trades', async () => {
    const service = new ExchangeService();
    const order = baseOrder({ id: 'buy-1' });

    await service.submitOrder(order);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'order.accepted',
        messages: [expect.objectContaining({ key: 'buy-1' })],
      }),
    );
    const payload = JSON.parse(send.mock.calls[0][0].messages[0].value);
    expect(payload).toEqual({ type: 'OrderAccepted', order });
  });

  it('publishes OrderAccepted and one TradeExecuted batch when an order crosses the book', async () => {
    const service = new ExchangeService();
    await service.submitOrder(baseOrder({ id: 'sell-1', side: 'SELL', price: 100, quantity: 10 }));
    send.mockClear();

    const result = await service.submitOrder(baseOrder({ id: 'buy-1', side: 'BUY', price: 100, quantity: 10 }));

    expect(result.trades).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ topic: 'order.accepted' }));
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        topic: 'trade.executed',
        messages: [expect.objectContaining({ key: result.trades[0].id })],
      }),
    );
  });

  it('publishes OrderCancelled when cancelOrder succeeds', async () => {
    const service = new ExchangeService();
    const order = baseOrder({ id: 'buy-1' });
    await service.submitOrder(order);
    send.mockClear();

    const removed = await service.cancelOrder('AAPL', 'buy-1');

    expect(removed).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'order.cancelled',
        messages: [expect.objectContaining({ key: 'buy-1' })],
      }),
    );
  });

  it('does not publish OrderCancelled when the order does not exist', async () => {
    const service = new ExchangeService();

    const removed = await service.cancelOrder('AAPL', 'missing');

    expect(removed).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows publish failures so order submission still succeeds', async () => {
    send.mockRejectedValueOnce(new Error('broker down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new ExchangeService();

    const result = await service.submitOrder(baseOrder({ id: 'buy-1' }));

    expect(result.remainingOrder).not.toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
