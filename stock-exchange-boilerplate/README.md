# Stock Exchange Boilerplate — Express + TypeScript

A tested, in-memory matching engine wrapped in a thin Express API, with an
event-sourced audit trail: every accept / trade / cancel is published to Kafka
and projected into a Postgres read model by a separate consumer process. Live
trades and book updates also fan out over a WebSocket for market data.

Covers Phases 1–5 of the roadmap (matching engine, REST API, persistence,
event log, WebSocket market data). Accounts/settlement and auth are still open.

## Structure
```
src/
  types/domain.ts            Core types: Order, Trade, MatchResult, BookSnapshot, ExchangeEvent
  types/schemas.ts           Zod request validation
  engine/OrderBook.ts        Price-time priority order book (per symbol), in-memory
  engine/matchOrder.ts       Pure matching function — no I/O, fully unit tested
  engine/ExchangeService.ts  Registry of OrderBooks by symbol; publishes to Kafka; emits 'trade'/'book'
  kafka/kafkaclient.ts       Shared Kafka client + producer, topic names
  db/prisma.ts               Shared PrismaClient
  db/persistExchangeEvent.ts Applies one ExchangeEvent to the Postgres read model
  ws/marketData.ts           WebSocket market-data fan-out (subscribe per symbol)
  routes/orders.ts           REST endpoints (see API below)
  app.ts                     Express app + middleware
  index.ts                   API entrypoint — Kafka producer, HTTP listen, WS attach
  consumer.ts                Standalone consumer entrypoint — Kafka -> Postgres projection
  tests/                     47 tests: matching engine, event publishing, read-model
                             projection, WebSocket fan-out, HTTP routes (supertest)
prisma/
  schema.prisma              Order + Trade read-model tables
  migrations/                SQL migrations
```

## Architecture

Two processes, decoupled through Kafka. The WebSocket layer lives in the API
process and taps ExchangeService's events directly (no Kafka round-trip):

```
HTTP  ─▶  API (src/index.ts)  ─▶  in-memory OrderBook          ─▶  HTTP response (trades, status)
                              ├─▶  producer.send(order.accepted / trade.executed / order.cancelled)
                              │               │
                              │               ▼   Kafka
                              │               │
                              │   consumer (src/consumer.ts)  ◀───┘
                              │               └─▶  persistExchangeEvent()  ─▶  Postgres (Order / Trade)
                              │                                                       │
                              │   HTTP  ─▶  API GET /:id, /:symbol/trades  ◀──────────┘  (read model)
                              │
                              └─▶  emit('trade'/'book')  ─▶  src/ws/marketData.ts  ─▶  WS clients
                                                                (same process, live fast path)
```

The matching engine is authoritative and synchronous. Event publishing is
best-effort — a Kafka outage does not stop orders being accepted. The consumer
is at-least-once (offsets commit after processing) and idempotent on `trade.id`,
and it tolerates out-of-order delivery across topics (a trade can arrive before
its `OrderAccepted`; a stub row is created and corrected later).

The WebSocket fan-out is intentionally **not** sourced from Kafka — it listens
to ExchangeService's in-process events, so it only sees activity on this one
API instance. That's fine for a single instance; once the exchange is sharded
(Phase 6) this should move to consuming the Kafka topics instead, the same way
the Postgres consumer does, so every instance sees every symbol.

## Run it

Bring up Kafka, Postgres, and the UIs:
```bash
docker compose up -d          # kafka :9094, kafka-ui :8080, postgres :5432, adminer :8081
```

Install deps and configure:
```bash
npm install
cp .env.example .env
```

Apply the database schema and generate the Prisma client (into `src/generated/prisma`):
```bash
npx prisma migrate deploy     # apply existing migrations  (or: npx prisma migrate dev)
npx prisma generate           # regenerate the client  (migrate dev does this for you)
```

Start the two processes in separate terminals:
```bash
npm run dev                   # API on http://localhost:4000, WS on ws://localhost:4000/ws/market-data
npm run consumer              # Kafka -> Postgres projection
```

> The consumer subscribes `fromBeginning`, so starting it late will replay the
> full event log and backfill Postgres. If you never start it, the REST/book
> endpoints and the WebSocket feed still work but the Postgres-backed
> endpoints return 503.

Tests need neither Kafka, Postgres, nor a live WebSocket client set up by
hand — all three are exercised directly (real `ws` client/server, real
`supertest` HTTP requests, mocked Kafka/Prisma):
```bash
npm test
npm run lint
npm run build
```

## API

REST (`src/routes/orders.ts`):
- `POST /api/orders` — `{ symbol, side, type, price, quantity }` → places an order, returns `{ orderId, trades, status, remainingQuantity }`.
  `status` is one of `OPEN` / `PARTIALLY_FILLED` / `FILLED` / `REJECTED` — `REJECTED` means a MARKET order found no liquidity at all (LIMIT orders never reject; unfilled quantity rests instead).
- `DELETE /api/orders/:symbol/:orderId` — cancel a resting order
- `GET /api/orders/:symbol/book` — current aggregated bid/ask levels (**in-memory book**, resets on API restart)
- `GET /api/orders/:symbol/trades` — trade history for a symbol from the **Postgres read model** (`?limit=`, 1–500, default 100)
- `GET /api/orders/:id` — status + fill progress for one order from the **Postgres read model** (survives restarts)
- `GET /health`

WebSocket (`src/ws/marketData.ts`), `ws://localhost:4000/ws/market-data`:
- Send `{"type":"subscribe","symbol":"AAPL"}` to start receiving updates for a symbol (an immediate `book` snapshot is sent right away so you're not left waiting for the next trade); `{"type":"unsubscribe","symbol":"AAPL"}` to stop.
- You'll receive `{"type":"trade","trade":{...}}` per fill and `{"type":"book","snapshot":{...}}` whenever that symbol's book changes.
- Malformed frames and unknown message types are silently ignored, not an error.

## Environment
```
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://exchange:exchange@localhost:5432/exchange?schema=public"
KAFKA_BROKER=localhost:9094   # optional, this is the default
```

## What's NOT here yet (see roadmap)
- No sharding by symbol / sorted book structure — `OrderBook` still re-sorts on every insert, and the WebSocket fan-out only covers one instance's activity (Phase 6)
- No accounts / balances / settlement
- No auth

## Known simplifications to revisit
- `OrderBook` re-sorts the full price-level array on every insert (`O(n log n)`). Fine for tests and demos; swap for a proper sorted structure once you're load testing (Phase 6).
- The API imports the matching result directly for its HTTP response; it does **not** wait for the Postgres projection, so `GET /api/orders/:id` may briefly 404 immediately after `POST` until the consumer catches up (read-your-writes is not guaranteed).
- The WebSocket layer is per-instance (see Architecture above) — not yet suitable behind more than one API process.
