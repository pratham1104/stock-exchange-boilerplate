import { IncomingOrder, MatchResult, RestingOrder } from '../types/domain';
import { exchangeService, ExchangeService } from './ExchangeService';
import { accountService, AccountService, InsufficientFundsError } from './AccountService';

export type SubmitOutcome =
  | { status: 'accepted'; result: MatchResult }
  | { status: 'rejected'; reason: string };

/**
 * Composes the matching engine (ExchangeService) with the ledger
 * (AccountService): reserve funds -> match -> settle each fill -> release the
 * reservation the resting remainder no longer needs. ExchangeService stays
 * account-agnostic; this is the layer that knows about money.
 */
export class TradingService {
  constructor(
    private readonly exchange: ExchangeService,
    private readonly accounts: AccountService,
  ) {}

  async submitOrder(order: IncomingOrder): Promise<SubmitOutcome> {
    // MARKET buys have no limit price to reserve against — price the sweep now.
    const estimatedCost =
      order.side === 'BUY' && order.type === 'MARKET'
        ? this.exchange.estimateBuyCost(order.symbol, order.quantity).cost
        : 0;

    try {
      this.accounts.reserveForOrder(order, estimatedCost);
    } catch (err) {
      if (err instanceof InsufficientFundsError) return { status: 'rejected', reason: err.message };
      throw err;
    }

    let result: MatchResult;
    try {
      result = await this.exchange.submitOrder(order);
    } catch (err) {
      this.accounts.releaseOrder(order.id); // matching blew up — don't strand the reservation
      throw err;
    }

    for (const trade of result.trades) this.accounts.settleTrade(trade);

    const restingRemaining = remainingQtyOf(result.remainingOrder);
    this.accounts.finalizeOrder(order.id, restingRemaining);

    // Publish fresh settled state once per touched account (taker + every maker).
    const touched = new Set<string>([order.accountId]);
    for (const trade of result.trades) {
      touched.add(trade.buyAccountId);
      touched.add(trade.sellAccountId);
    }
    await Promise.all([...touched].map((id) => this.accounts.publishState(id, 'settlement')));

    return { status: 'accepted', result };
  }

  async cancelOrder(
    symbol: string,
    orderId: string,
    requesterAccountId: string,
  ): Promise<{ status: 'cancelled'; order: RestingOrder } | { status: 'not_found' } | { status: 'forbidden' }> {
    const owner = this.accounts.ownerOfOrder(orderId);
    if (owner && owner !== requesterAccountId) return { status: 'forbidden' };

    const removed = await this.exchange.cancelOrder(symbol, orderId);
    if (!removed) return { status: 'not_found' };

    this.accounts.releaseOrder(orderId);
    await this.accounts.publishState(removed.accountId, 'settlement');
    return { status: 'cancelled', order: removed };
  }

  getSnapshot(symbol: string) {
    return this.exchange.getSnapshot(symbol);
  }
}

function remainingQtyOf(order: RestingOrder | null): number {
  return order ? order.quantity - order.filledQuantity : 0;
}

// Singleton wiring for this boilerplate.
export const tradingService = new TradingService(exchangeService, accountService);
