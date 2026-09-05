export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';

/** An order as submitted by a client, before the matching engine has touched it. */
export interface IncomingOrder {
  id: string;
  accountId: string; // owning account — set from the authenticated caller, not the request body
  symbol: string;
  side: Side;
  type: OrderType;
  price: number | null; // null for MARKET orders
  quantity: number;
  timestamp: number;
}

/** An order sitting on the book, tracking how much of it has already traded. */
export interface RestingOrder extends IncomingOrder {
  filledQuantity: number;
}

/** A single execution produced by matching a buy order against a sell order. */
export interface Trade {
  id: string;
  symbol: string;
  buyOrderId: string;
  sellOrderId: string;
  buyAccountId: string;
  sellAccountId: string;
  price: number;
  quantity: number;
  timestamp: number;
}

/** Post-match state of a resting order that the incoming order traded against. */
export interface MakerFill {
  orderId: string;
  totalQuantity: number;
  filledQuantity: number; // cumulative, after this match
}

/** Outcome of running an incoming order through the matching engine. */
export interface MatchResult {
  trades: Trade[];
  // Order that was not fully filled and needs to rest on the book (if any).
  // null if fully filled or if a market order couldn't be filled at all.
  remainingOrder: RestingOrder | null;
  // How much of the incoming order's quantity was matched. Needed alongside
  // remainingOrder to tell "fully filled" apart from "market order dropped
  // unfilled/partially filled" — both leave remainingOrder null.
  filledQuantity: number;
  // Resting orders that were (partly) consumed — so their rows can be updated.
  makerFills: MakerFill[];
}

/** A holding: how many shares of a symbol an account owns. */
export interface Position {
  symbol: string;
  quantity: number;
}

/** Public view of an account — balances and holdings, never the API key. */
export interface AccountView {
  id: string;
  name: string;
  cashBalance: number; // spendable now (excludes cash reserved by open buy orders)
  reservedCash: number; // held against open buy orders
  positions: Position[];
}

/** Published when an incoming order has been accepted by the matching engine. */
export interface OrderAcceptedEvent {
  type: 'OrderAccepted';
  order: IncomingOrder;
}

/** Published once per trade produced while matching an order. */
export interface TradeExecutedEvent {
  type: 'TradeExecuted';
  trade: Trade;
}

/** Published when a resting order is cancelled before it fills. */
export interface OrderCancelledEvent {
  type: 'OrderCancelled';
  orderId: string;
  symbol: string;
}

/**
 * The order/trade/cancel event stream published to Kafka. Postgres is the
 * source of truth (the API write-throughs); this stream drives the market-data
 * WebSocket and is available for external consumers / audit.
 */
export type ExchangeEvent = OrderAcceptedEvent | TradeExecutedEvent | OrderCancelledEvent;

/** Order lifecycle status as stored in Postgres. */
export type StoredOrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

/** Aggregated view of an order book, grouped by price level rather than individual orders. */
export interface BookSnapshot {
  symbol: string;
  bids: Array<{ price: number; quantity: number; orderCount: number }>;
  asks: Array<{ price: number; quantity: number; orderCount: number }>;
}
