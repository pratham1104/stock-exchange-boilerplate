export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';

/** An order as submitted by a client, before the matching engine has touched it. */
export interface IncomingOrder {
  id: string;
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
  price: number;
  quantity: number;
  timestamp: number;
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

export type ExchangeEvent = OrderAcceptedEvent | TradeExecutedEvent | OrderCancelledEvent;

/** Aggregated view of an order book, grouped by price level rather than individual orders. */
export interface BookSnapshot {
  symbol: string;
  bids: Array<{ price: number; quantity: number; orderCount: number }>;
  asks: Array<{ price: number; quantity: number; orderCount: number }>;
}
