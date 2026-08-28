# Stock Exchange Boilerplate — Express + TypeScript

Matches Phase 1 & 2 of the roadmap: a pure, tested matching engine wrapped in a thin Express API.

## Structure
```
src/
  types/domain.ts       Core types: Order, Trade, MatchResult, BookSnapshot
  types/schemas.ts       Zod request validation
  engine/OrderBook.ts     Price-time priority order book (per symbol)
  engine/matchOrder.ts    Pure matching function — no I/O, fully unit tested
  engine/ExchangeService.ts  Registry of OrderBooks by symbol, singleton
  routes/orders.ts        POST /submit, DELETE /cancel, GET /book
  app.ts                  Express app + middleware
  index.ts                Entrypoint
  tests/matchOrder.test.ts  8 tests: fills, partials, market orders, priority, cancel
```

## Run it
```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:4000
npm test           # run the matching engine test suite
```

## API
- `POST /api/orders` — `{ symbol, side, type, price, quantity }` → places an order, returns trades + status
- `DELETE /api/orders/:symbol/:orderId` — cancel a resting order
- `GET /api/orders/:symbol/book` — current book snapshot (aggregated price levels)
- `GET /health`

## What's deliberately NOT here yet (see roadmap)
- No persistence (Postgres) — book is in-memory only, resets on restart
- No Kafka event log / audit trail
- No WebSocket market data fanout
- No accounts/balances/settlement
- No auth

Build these in per the phased roadmap — don't bolt them all on before the matching engine logic itself is bulletproof and tested.

## Known simplification to revisit
`OrderBook` re-sorts the full price-level array on every insert (`O(n log n)`). Fine for tests and demos; swap for a proper sorted structure (e.g. array of price-level buckets, or a balanced tree keyed by price) once you're load testing (Phase 6).
