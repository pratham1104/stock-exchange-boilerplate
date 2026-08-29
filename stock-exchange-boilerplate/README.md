# Stock Exchange Boilerplate — Express + TypeScript

A tested, in-memory matching engine wrapped in a thin Express API, with an
event-sourced audit trail: every accept / trade / cancel is published to Kafka
and projected into a Postgres read model by a separate consumer process.

Covers Phases 1–4 of the roadmap (matching engine, REST API, persistence,
event log). WebSocket market data, accounts/settlement, and auth are still open.

## Structure
```
src/
  types/domain.ts            Core types: Order, Trade, MatchResult, BookSnapshot, ExchangeEvent
  types/schemas.ts           Zod request validation
  engine/OrderBook.ts        Price-time priority order book (per symbol), in-memory
  engine/matchOrder.ts       Pure matching function — no I/O, fully unit tested
  engine/ExchangeService.ts  Registry of OrderBooks by symbol; publishes events to Kafka
  kafka/kafkaclient.ts       Shared Kafka client + producer, topic names
  db/prisma.ts               Shared PrismaClient
  db/persistExchangeEvent.ts Applies one ExchangeEvent to the Postgres read model
  routes/orders.ts           REST endpoints (see API below)
  app.ts                     Express app + middleware
  index.ts                   API entrypoint — connects the Kafka producer, starts listening
  consumer.ts                Standalone consumer entrypoint — Kafka -> Postgres projection
  tests/                     25 tests: matching engine, event publishing, read-model projection
prisma/
  schema.prisma              Order + Trade read-model tables
  migrations/                SQL migrations
```

## Architecture

Two processes, decoupled through Kafka:

```
HTTP  ─▶  API (src/index.ts)  ─▶  in-memory OrderBook          ─▶  HTTP response (trades, status)
                              └─▶  producer.send(order.accepted / trade.executed / order.cancelled)
                                              │
                                              ▼   Kafka
                                              │
          consumer (src/consumer.ts)  ◀───────┘
                              └─▶  persistExchangeEvent()  ─▶  Postgres (Order / Trade tables)
                                                                      │
HTTP  ─▶  API GET /:id, /:symbol/trades  ◀───────────────────────────┘  (read model)
```

The matching engine is authoritative and synchronous. Event publishing is
best-effort — a Kafka outage does not stop orders being accepted. The consumer
is at-least-once (offsets commit after processing) and idempotent on `trade.id`,
and it tolerates out-of-order delivery across topics (a trade can arrive before
its `OrderAccepted`; a stub row is created and corrected later).

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
npm run dev                   # API on http://localhost:4000
npm run consumer              # Kafka -> Postgres projection
```

> The consumer subscribes `fromBeginning`, so starting it late will replay the
> full event log and backfill Postgres. If you never start it, the REST/book
> endpoints still work but the Postgres-backed endpoints return 503.

Tests need neither Kafka nor Postgres (both are mocked):
```bash
npm test
```

## API
- `POST /api/orders` — `{ symbol, side, type, price, quantity }` → places an order, returns `{ orderId, trades, status, remainingQuantity }`
- `DELETE /api/orders/:symbol/:orderId` — cancel a resting order
- `GET /api/orders/:symbol/book` — current aggregated bid/ask levels (**in-memory book**, resets on API restart)
- `GET /api/orders/:symbol/trades` — trade history for a symbol from the **Postgres read model** (`?limit=`, 1–500, default 100)
- `GET /api/orders/:id` — status + fill progress for one order from the **Postgres read model** (survives restarts)
- `GET /health`

## Environment
```
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://exchange:exchange@localhost:5432/exchange?schema=public"
KAFKA_BROKER=localhost:9094   # optional, this is the default
```

## What's NOT here yet (see roadmap)
- No WebSocket market-data fanout (Phase 5)
- No sharding by symbol / sorted book structure — `OrderBook` still re-sorts on every insert (Phase 6)
- No accounts / balances / settlement
- No auth

## Known simplifications to revisit
- `OrderBook` re-sorts the full price-level array on every insert (`O(n log n)`). Fine for tests and demos; swap for a proper sorted structure once you're load testing (Phase 6).
- `lint` script references an ESLint config that doesn't exist yet — `npm run lint` currently fails.
- The API imports the matching result directly for its HTTP response; it does **not** wait for the Postgres projection, so `GET /api/orders/:id` may briefly 404 immediately after `POST` until the consumer catches up (read-your-writes is not guaranteed).
