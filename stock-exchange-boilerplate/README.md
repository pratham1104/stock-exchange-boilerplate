# Stock Exchange Boilerplate — Express + TypeScript

A tested matching engine and ledger behind a thin Express API:

- **Matching engine** — price-time priority, per-symbol order books, in-memory and authoritative
- **Accounts & settlement** — cash + share balances, funds reserved when an order is placed, cash and shares moved between accounts as fills happen
- **Auth** — per-account API keys (bearer tokens)
- **Event log** — every accept / trade / cancel / account change is published to Kafka
- **Read model** — a separate consumer projects those events into Postgres for durable, queryable history
- **Market data** — live trade + order-book updates over WebSocket

Covers Phases 1–6 of the roadmap. Still open: multi-instance sharding, and a
real deposit/withdrawal + KYC flow (the current deposit endpoint is a demo shim).

## Structure
```
src/
  types/domain.ts            Core types: Order, Trade, MatchResult, Position, AccountView, events
  types/schemas.ts           Zod request validation
  types/express.d.ts         Request augmentation for req.accountId
  auth/apiKey.ts             Bearer-token auth middleware (in-memory key index)
  engine/OrderBook.ts        Per-symbol book: price-level buckets, best-first, FIFO within a level
  engine/matchOrder.ts       Pure matching function — no I/O, fully unit tested
  engine/ExchangeService.ts  Registry of OrderBooks; Kafka order/trade events; in-process 'trade'/'book'
  engine/AccountService.ts   In-memory ledger: cash, holdings, per-order reservations; AccountUpdated events
  engine/TradingService.ts   Composes the two: reserve -> match -> settle -> release
  kafka/kafkaclient.ts       Shared Kafka client + producer, topic names
  db/prisma.ts               Shared PrismaClient
  db/persistExchangeEvent.ts Applies one event (order / trade / account) to the Postgres read model
  ws/marketData.ts           WebSocket market-data fan-out (subscribe per symbol)
  routes/orders.ts           Order + book + history endpoints
  routes/accounts.ts         Account create / me / deposit
  app.ts                     Express app + middleware
  index.ts                   API entrypoint — Kafka producer, HTTP listen, WS attach
  consumer.ts                Standalone consumer entrypoint — Kafka -> Postgres projection
  tests/                     83 tests (matching, book structure, ledger/settlement, projection,
                             WebSocket fan-out, HTTP routes)
prisma/
  schema.prisma              Order / Trade / Account / Position read-model tables
  migrations/                SQL migrations
```

## Architecture

Two processes, decoupled through Kafka. The matching engine and the ledger are
both in-memory and authoritative in the API process; Postgres is a read model
rebuilt from the event log by the consumer.

```
                    ┌─ TradingService ─ reserve funds (AccountService)
HTTP POST /orders ──┤                   match (ExchangeService / OrderBook)
   (authenticated)  │                   settle each fill (AccountService)
                    └─ publish: order.accepted / trade.executed / account.updated ─┐
                                                                                   │  Kafka
HTTP GET /book, /accounts/me  ◀── in-memory (authoritative, current)               │
                                                                                   ▼
                            consumer (src/consumer.ts)  ─ persistExchangeEvent ─▶ Postgres
                                                                                   │
HTTP GET /orders/:id, /orders/:symbol/trades  ◀────────────────────────────────────┘

ExchangeService also emits in-process 'trade'/'book' ─▶ ws/marketData.ts ─▶ WS clients
```

Design notes:
- **Matching is synchronous and authoritative.** Kafka publishing is best-effort — a broker outage does not stop orders being accepted or settled.
- **The consumer is at-least-once** (offsets commit after processing), idempotent on `trade.id`, and tolerant of out-of-order delivery across topics (a trade can land before its `OrderAccepted`; a stub row is created and corrected later).
- **`AccountUpdated` events carry the full post-change snapshot**, so the read model upserts without reconciling against prior state.
- **Accounts and API keys live only in the API process** and are lost on restart — the same tradeoff as the in-memory book. A real deployment would persist hashed keys and check them in `auth/apiKey.ts`.
- **The WebSocket feed is per-instance** (fed from in-process events, not Kafka) — fine for one API process; Phase-6 sharding would move it to consuming the Kafka topics.

## Run it

```bash
docker compose up -d          # kafka :9094, kafka-ui :8080, postgres :5432, adminer :8081
npm install
cp .env.example .env
npx prisma migrate deploy     # apply migrations  (or: npx prisma migrate dev)
npx prisma generate           # regenerate the client  (migrate dev does this for you)
```

Two processes, separate terminals:
```bash
npm run dev                   # API on :4000, WS on ws://localhost:4000/ws/market-data
npm run consumer              # Kafka -> Postgres projection
```

> The consumer subscribes `fromBeginning`, so starting it late replays the full
> event log and backfills Postgres. Without it, the in-memory endpoints and the
> WebSocket feed still work; the Postgres-backed endpoints return 503.

```bash
npm test        # 83 tests — no Kafka or Postgres needed (both mocked)
npm run lint
npm run build
```

## Accounts & auth

Every order belongs to an account, identified by a bearer API key.

```bash
# 1. Open an account — the apiKey is shown once, store it
curl -sX POST localhost:4000/api/accounts \
  -H 'content-type: application/json' \
  -d '{"name":"alice","startingCash":100000}'
# -> { "account": { "id": "...", "cashBalance": 100000, ... }, "apiKey": "..." }

# 2. (demo) fund it with shares so it can sell
curl -sX POST localhost:4000/api/accounts/me/deposit \
  -H 'authorization: Bearer <apiKey>' -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","quantity":500}'

# 3. place an order
curl -sX POST localhost:4000/api/orders \
  -H 'authorization: Bearer <apiKey>' -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","side":"SELL","type":"LIMIT","price":150,"quantity":100}'
```

When an order is placed, funds are **reserved**: a BUY holds `price × quantity`
cash (a MARKET buy holds the cost to sweep the book right now); a SELL holds the
shares. Reservations are drawn down as fills settle, and released on cancel or
for the part of a MARKET order that couldn't fill. An order the account can't
cover is rejected with **422**.

## API

Auth column: 🔑 = requires `Authorization: Bearer <apiKey>`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/accounts` | — | Open an account; returns the account view + one-time API key |
| GET | `/api/accounts/me` | 🔑 | Authenticated account's cash, reserved cash, and positions |
| POST | `/api/accounts/me/deposit` | 🔑 | Fund with `{cash}` and/or `{symbol,quantity}` (demo shim) |
| POST | `/api/orders` | 🔑 | Place an order → `{ orderId, trades, status, remainingQuantity }` |
| DELETE | `/api/orders/:symbol/:orderId` | 🔑 | Cancel a resting order you own (403 if it's another account's) |
| GET | `/api/orders/:symbol/book` | — | Aggregated bid/ask levels (in-memory book, resets on restart) |
| GET | `/api/orders/:symbol/trades` | — | Trade history from the Postgres read model (`?limit=`, 1–500, default 100) |
| GET | `/api/orders/:id` | — | One order's status + fill progress from the read model |
| GET | `/health` | — | Liveness probe |

`POST /api/orders` `status`: `OPEN` / `PARTIALLY_FILLED` / `FILLED` / `REJECTED`.
`REJECTED` means a MARKET order found no liquidity at all (a LIMIT order never
rejects — unfilled quantity rests). Insufficient funds is a `422`, not a status.

### WebSocket — `ws://localhost:4000/ws/market-data`

- `{"type":"subscribe","symbol":"AAPL"}` — start receiving updates (an immediate `book` snapshot is sent); `{"type":"unsubscribe","symbol":"AAPL"}` to stop.
- Inbound pushes: `{"type":"trade","trade":{...}}` per fill, `{"type":"book","snapshot":{...}}` on any book change.
- Malformed frames and unknown message types are ignored, not errors.

## Kafka topics

| Topic | Payload | Consumer action |
| --- | --- | --- |
| `order.accepted` | `OrderAccepted` | upsert Order row |
| `trade.executed` | `TradeExecuted` | insert Trade row (idempotent on id), apply fills to both orders |
| `order.cancelled` | `OrderCancelled` | mark Order `CANCELLED` |
| `account.updated` | `AccountUpdated` (full snapshot) | upsert Account, replace its Positions |

## Environment
```
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://exchange:exchange@localhost:5432/exchange?schema=public"
KAFKA_BROKER=localhost:9094   # optional, this is the default
```

## Known simplifications to revisit
- **Accounts / API keys are in-memory** — lost on restart, no persistence-backed auth. The Postgres `Account`/`Position` tables are a read model only (no key material).
- **`/deposit` is a demo shim**, not a real funding/settlement system — no double-entry ledger, no external rails, no KYC.
- **Single instance.** `OrderBook` uses price-level buckets in a sorted array (splice on a new level is O(L)); a balanced tree keyed by price would remove that. The WebSocket feed and the in-memory ledger both assume one API process.
- **No read-your-writes on the read model** — `GET /api/orders/:id` can 404 briefly right after `POST` until the consumer catches up.
- MARKET-buy affordability is checked against a *snapshot* of the book; a concurrent fill between the estimate and the match could in principle move the price (single-threaded Node makes this a non-issue today, but it's a real constraint under sharding).
