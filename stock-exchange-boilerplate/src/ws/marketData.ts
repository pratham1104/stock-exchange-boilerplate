import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { exchangeService } from '../engine/ExchangeService';
import { Trade, BookSnapshot } from '../types/domain';

/**
 * Inbound control messages a client can send after connecting.
 * Everything else (malformed JSON, unknown type) is silently ignored — this
 * is a best-effort market-data feed, not a request/response protocol.
 */
type ClientMessage =
  | { type: 'subscribe'; symbol: string }
  | { type: 'unsubscribe'; symbol: string };

/** Outbound messages pushed to subscribed clients. */
export type MarketDataMessage =
  | { type: 'trade'; trade: Trade }
  | { type: 'book'; snapshot: BookSnapshot };

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object') return false;
  const { type, symbol } = value as Record<string, unknown>;
  return (type === 'subscribe' || type === 'unsubscribe') && typeof symbol === 'string' && symbol.length > 0;
}

/**
 * Attaches a WebSocket market-data feed to an existing HTTP server, at `path`
 * (default /ws/market-data). Clients opt into symbols by sending
 * `{"type":"subscribe","symbol":"AAPL"}`; they then receive every
 * `{"type":"trade", trade}` and `{"type":"book", snapshot}` for that symbol
 * until they unsubscribe or disconnect.
 *
 * This listens on ExchangeService's in-process 'trade'/'book' events (see
 * ExchangeService.ts) — it is a live fan-out, not sourced from Kafka, so it
 * only reflects activity on this API instance. Fine for one instance; once
 * the exchange is sharded/scaled out (Phase 6), this should read off the
 * Kafka topics like the Postgres consumer does, so every instance sees every
 * symbol's activity regardless of which instance accepted the order.
 */
export function attachMarketData(server: HttpServer, path = '/ws/market-data'): WebSocketServer {
  const wss = new WebSocketServer({ server, path });
  const subscriptions = new Map<WebSocket, Set<string>>();

  const send = (ws: WebSocket, message: MarketDataMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const broadcast = (symbol: string, message: MarketDataMessage): void => {
    for (const [ws, symbols] of subscriptions) {
      if (symbols.has(symbol)) send(ws, message);
    }
  };

  const onTrade = (trade: Trade): void => broadcast(trade.symbol, { type: 'trade', trade });
  const onBook = (symbol: string, snapshot: BookSnapshot): void => broadcast(symbol, { type: 'book', snapshot });

  exchangeService.on('trade', onTrade);
  exchangeService.on('book', onBook);

  wss.on('connection', (ws: WebSocket) => {
    subscriptions.set(ws, new Set());

    ws.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames
      }
      if (!isClientMessage(parsed)) return;

      const symbols = subscriptions.get(ws);
      if (!symbols) return;

      if (parsed.type === 'subscribe') {
        symbols.add(parsed.symbol);
        // Send an immediate snapshot so a new subscriber isn't stuck waiting
        // for the next trade to know the current book.
        send(ws, { type: 'book', snapshot: exchangeService.getSnapshot(parsed.symbol) as BookSnapshot });
      } else {
        symbols.delete(parsed.symbol);
      }
    });

    ws.on('close', () => subscriptions.delete(ws));
  });

  // Kept mainly so tests / callers can tear this down cleanly (removes the
  // ExchangeService listeners, which would otherwise outlive a closed server).
  wss.on('close', () => {
    exchangeService.off('trade', onTrade);
    exchangeService.off('book', onBook);
  });

  return wss;
}
