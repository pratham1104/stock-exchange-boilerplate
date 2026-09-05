import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';

vi.mock('../kafka/kafkaclient', () => ({
  producer: { send: vi.fn().mockResolvedValue(undefined) },
  TOPICS: { ORDER_ACCEPTED: 'order.accepted', TRADE_EXECUTED: 'trade.executed', ORDER_CANCELLED: 'order.cancelled' },
}));

const { exchangeService } = await import('../engine/ExchangeService');
const { attachMarketData } = await import('../ws/marketData');

/**
 * Full-stack test: a real HTTP server, a real `ws` server attached to it via
 * attachMarketData, and a real `ws` client — no mocking of the WebSocket
 * layer itself. Only Kafka (irrelevant here) is mocked.
 */

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  httpServer = createServer();
  attachMarketData(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `ws://localhost:${port}/ws/market-data`;
});

afterAll(() => {
  httpServer.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
  });
}

/** Waits for the next message of a given `type`, silently draining any others in between. */
function nextMessageOfType(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type) {
        ws.off('message', onMessage);
        resolve(message);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('market-data WebSocket', () => {
  it('sends an immediate book snapshot on subscribe', async () => {
    const ws = await connect();
    const message = nextMessage(ws);

    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'MDWS1' }));

    await expect(message).resolves.toMatchObject({ type: 'book', snapshot: { symbol: 'MDWS1' } });
    ws.close();
  });

  it('broadcasts a trade only to clients subscribed to that symbol', async () => {
    const subscribed = await connect();
    const unsubscribed = await connect();

    subscribed.send(JSON.stringify({ type: 'subscribe', symbol: 'MDWS2' }));
    await nextMessage(subscribed); // consume the initial book snapshot

    const tradeMessage = nextMessageOfType(subscribed, 'trade'); // the sell order resting also emits a 'book'
    const unsubscribedGotSomething = vi.fn();
    unsubscribed.on('message', unsubscribedGotSomething);

    await exchangeService.submitOrder({
      id: 'sell-1',
      symbol: 'MDWS2',
      side: 'SELL',
      type: 'LIMIT',
      price: 50,
      quantity: 5,
      timestamp: Date.now(),
    });
    await exchangeService.submitOrder({
      id: 'buy-1',
      symbol: 'MDWS2',
      side: 'BUY',
      type: 'LIMIT',
      price: 50,
      quantity: 5,
      timestamp: Date.now(),
    });

    const trade = await tradeMessage;
    expect(trade).toMatchObject({ type: 'trade', trade: { symbol: 'MDWS2', quantity: 5, price: 50 } });
    expect(unsubscribedGotSomething).not.toHaveBeenCalled();

    subscribed.close();
    unsubscribed.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'MDWS3' }));
    await nextMessage(ws); // initial snapshot

    ws.send(JSON.stringify({ type: 'unsubscribe', symbol: 'MDWS3' }));
    // Give the server a tick to process the unsubscribe before we trade.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const gotSomething = vi.fn();
    ws.on('message', gotSomething);

    await exchangeService.submitOrder({
      id: 'buy-2',
      symbol: 'MDWS3',
      side: 'BUY',
      type: 'LIMIT',
      price: 10,
      quantity: 1,
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(gotSomething).not.toHaveBeenCalled();
    ws.close();
  });

  it('ignores malformed and unknown messages without closing the connection', async () => {
    const ws = await connect();

    ws.send('not json');
    ws.send(JSON.stringify({ type: 'subscribe' })); // missing symbol
    ws.send(JSON.stringify({ type: 'ping' })); // unknown type

    // Connection should still be usable afterwards.
    const message = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'MDWS4' }));
    await expect(message).resolves.toMatchObject({ type: 'book' });

    ws.close();
  });
});
