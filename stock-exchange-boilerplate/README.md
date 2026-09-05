# Stock Exchange — Express + TypeScript

A matching engine and ledger behind a REST + WebSocket API, with **Postgres as
the source of truth**. State is rebuilt from the database on startup, so a crash
recovers exactly.

- **Matching engine** — price-time priority, per-symbol order books (price-level buckets)
- **Accounts & settlement** — cash + share balances, funds reserved when an order is placed, cash and shares moved between accounts as fills happen
- **Auth** — per-account API keys (bearer tokens); only sha256(key) is ever stored
- **Write-through persistence** — every accept / fill / cancel and both accounts' new balances land in Postgres in one transaction, alongside the match
- **Startup rehydration** — the in-memory ledger and books are rebuilt from Postgres before the server accepts traffic
- **Market data** — live trade + order-book updates over WebSocket
- **Ops** — `/health` + `/health/ready`, graceful shutdown, fail-fast config validation, per-account rate limiting, structured logs (pino)

## Architecture

```
                          ┌──────────────── API process ────────────────┐
POST /api/orders  ──▶  TradingService (per-symbol lock)                  │
  (authenticated)        1. reserve funds/shares         AccountService  │  in-memory,
  rate-limited           2. match                        OrderBook       │  rebuilt from
                         3. settle each fill             AccountService  │  Postgres on boot
                         4. write order + trades + both accounts ──────────▶ Postgres  ◀── SOURCE OF TRUTH
                            in ONE transaction                           │      ▲
                         5. publish order.accepted / trade.executed ─────────┐ │
                                                                        │    │ │ rehydrate()
GET /health/ready ──▶ pings Postgres, checks consistency flag           │    │ │ on startup
GET /api/accounts/me, /orders/:symbol/book ──▶ in-memory (current)      │    ▼ │
GET /api/orders/:id, /orders/:symbol/trades ──▶ Postgres                │  ExchangeService emits
                          └──────────────────────────────────────────────┘  'trade'/'book' ──▶ ws/marketData ──▶ WS clients
                                                                            │
                                                             Kafka ◀────────┘  (market data + optional external consumers;
                                                                                NOT required for correctness)
```

Key decisions:

- **Postgres is authoritative.** The in-memory ledger and books are a fast cache. `index.ts` rebuilds them from Postgres (`loadAccountSnapshots`, `loadOpenOrders` → `AccountService.hydrate`, `ExchangeService.hydrateBook`, `rebuildReservation`) before `listen()`. A `SIGKILL` mid-trade recovers: any order/trade the transaction didn't commit simply isn't there, and the counterparty's resting order comes back.
- **One transaction per operation.** An order, its fills, the maker-order updates, and both accounts' balances commit atomically or not at all (`prisma.$transaction`).
- **Fail-stop on a persistence failure.** If the transaction throws after the in-memory mutation, the service is marked degraded → `/health/ready` returns 503 → the orchestrator restarts it → rehydration reconciles. There is deliberately no in-memory rollback of a settled trade.
- **Per-symbol serialization.** `TradingService` holds a promise-chain lock per symbol so concurrent submissions can't interleave across `await` points.
- **Cash model.** `Account.cashBalance` is *settled* (gross) cash. Cash reserved by open buy orders is **not** deducted in the DB — the reservation is re-derived from the open `Order` rows on restart. `spendable = cashBalance − reservedCash` (shown as `cashBalance` in `GET /me`).
- **Kafka is not load-bearing.** `order.accepted` / `trade.executed` / `order.cancelled` drive the market-data WebSocket and are available for external consumers. Publishing is best-effort; a broker outage never blocks a trade. `src/consumer.ts` is an *example* stream consumer (logs events) — the API owns all Postgres writes.

## Structure
```
src/
  config.ts                  Validated env — throws at boot if a required var is missing
  logger.ts                  pino (pretty in dev, JSON in prod)
  types/domain.ts            Core types + the Kafka event union
  types/schemas.ts           Zod request validation
  types/express.d.ts         Request augmentation (req.accountId)
  auth/apiKey.ts             Bearer-token middleware (sha256 hash lookup)
  http/rateLimit.ts          Dependency-free fixed-window limiter
  engine/OrderBook.ts        Per-symbol book: price-level buckets, best-first, FIFO in a level
  engine/matchOrder.ts       Pure matching function (returns trades + maker fills)
  engine/ExchangeService.ts  Books registry; Kafka publish; 'trade'/'book' events; hydrateBook()
  engine/AccountService.ts   In-memory ledger: settled cash, holdings, reservations; hydrate/snapshot/restore
  engine/TradingService.ts   Orchestrator: lock → reserve → match → settle → write-through transaction
  db/prisma.ts               PrismaClient + pingDatabase()
  db/persistence.ts          Write-through helpers (order / trade / account rows)
  db/rehydrate.ts            Startup loaders (accounts, open orders)
  ws/marketData.ts           WebSocket market-data fan-out
  routes/                    health, accounts, orders
  app.ts / index.ts          App factory / entrypoint (validate → wait for DB → rehydrate → listen)
  consumer.ts                Example Kafka consumer (optional, logs only)
prisma/                      schema + migrations (Order / Trade / Account / Position)
src/tests/                   97 tests, incl. a full crash-and-rehydrate integration test
```

## Run it

```bash
docker compose up -d          # kafka :9094, kafka-ui :8080, postgres :5432, adminer :8081
npm install
cp .env.example .env
npm run migrate:deploy        # apply migrations  (prisma migrate deploy)
npm run build                 # runs `prisma generate` then tsc
npm run dev                   # API on :4000, WS on ws://localhost:4000/ws/market-data
```

`npm run consumer` (optional) runs the example event-stream consumer.

```bash
npm test          # 97 tests — no Postgres or Kafka needed (both faked)
npm run lint
```

## Accounts & auth

Every order belongs to an account, identified by a bearer API key. Account
creation is open (that's how you get your first key); everything else needs
`Authorization: Bearer <apiKey>`.

```bash
# 1. open an account — apiKey is returned once, store it
curl -sX POST localhost:4000/api/accounts \
  -H 'content-type: application/json' -d '{"name":"alice","startingCash":100000}'

# 2. (demo) fund it with shares so it can sell
curl -sX POST localhost:4000/api/accounts/me/deposit \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","quantity":500}'

# 3. place an order
curl -sX POST localhost:4000/api/orders \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","side":"SELL","type":"LIMIT","price":150,"quantity":100}'
```

Placing an order **reserves** funds: a BUY holds `price × quantity` cash (a MARKET
buy holds the cost to sweep the book now); a SELL holds the shares. Reservations
draw down as fills settle and are released on cancel / for the unfilled part of a
MARKET order. An order the account can't cover is **422**.

## API

🔑 = requires `Authorization: Bearer <apiKey>`

| Method | Path | | Description |
| --- | --- | --- | --- |
| POST | `/api/accounts` | — | Open an account → account view + one-time API key |
| GET | `/api/accounts/me` | 🔑 | Cash, reserved cash, positions (from memory — always current) |
| POST | `/api/accounts/me/deposit` | 🔑 | Fund with `{cash}` and/or `{symbol,quantity}` (demo shim) |
| POST | `/api/orders` | 🔑 | Place an order (rate-limited) → `{ orderId, trades, status, remainingQuantity }` |
| DELETE | `/api/orders/:symbol/:orderId` | 🔑 | Cancel a resting order you own (403 for someone else's) |
| GET | `/api/orders/:symbol/book` | — | Aggregated bid/ask levels (in-memory) |
| GET | `/api/orders/:symbol/trades` | — | Trade history from Postgres (`?limit=`, 1–500) |
| GET | `/api/orders/:id` | — | One order's status + fills from Postgres |
| GET | `/health` | — | Liveness |
| GET | `/health/ready` | — | Readiness — 503 if Postgres unreachable or state is degraded |

`POST /api/orders` `status`: `OPEN` / `PARTIALLY_FILLED` / `FILLED` / `REJECTED`
(`REJECTED` = a MARKET order with no liquidity). Insufficient funds → 422.
`503` on a persistence failure (state is being reconciled — retry).

### WebSocket — `ws://localhost:4000/ws/market-data`

`{"type":"subscribe","symbol":"AAPL"}` → an immediate `book` snapshot, then
`{"type":"trade",...}` per fill and `{"type":"book",...}` on any change.
`{"type":"unsubscribe","symbol":"AAPL"}` to stop. Malformed frames are ignored.

## Production notes & what's still out of scope

**In place:** durable state (crash recovery), atomic write-through, fail-stop +
readiness probe, per-symbol serialization, API-key hashing, rate limiting,
graceful shutdown, config validation, structured logging.

**Deliberately not built:**

- **Horizontal scaling / sharding.** Single API process — the book, the ledger, and the per-symbol lock are in-process. Scaling out means partitioning symbols across instances (and moving the rate-limit counter to Redis, the market-data feed to Kafka-sourced).
- **Real funding.** `/deposit` is a demo shim — no double-entry journal, no payment rails, no KYC/AML. A real system needs an append-only ledger table written in the same transaction as settlement.
- **Throughput.** Persistence is on the order hot path (a few writes per order inside a transaction). Fine for typical loads; an HFT-grade engine would use a write-ahead log with async projection — the Kafka topics are already there for that.
- **MARKET-buy affordability** is checked against a book *snapshot*; safe under single-threaded Node + the per-symbol lock, but a constraint to revisit under sharding.
- No distributed tracing, TLS termination, secrets manager, or CI config — those are deployment concerns, not application code.
