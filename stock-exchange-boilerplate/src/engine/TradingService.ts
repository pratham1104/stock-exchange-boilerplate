import { IncomingOrder, MatchResult, RestingOrder } from '../types/domain';
import { exchangeService, ExchangeService } from './ExchangeService';
import { accountService, AccountService, InsufficientFundsError } from './AccountService';
import { prisma } from '../db/prisma';
import type { PrismaClient } from '../generated/prisma/client';
import {
  insertOrder,
  updateOrderFill,
  markOrderCancelled,
  insertTrade,
  writeAccountSnapshot,
  storedStatus,
} from '../db/persistence';
import { logger } from '../logger';

export type SubmitOutcome =
  | { status: 'accepted'; result: MatchResult }
  | { status: 'rejected'; reason: string }
  | { status: 'error'; reason: string };

export type CancelOutcome =
  | { status: 'cancelled'; order: RestingOrder }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'error' };

/**
 * Orchestrates a trade: serialize per symbol -> reserve funds -> match ->
 * settle each fill -> release the reservation the resting remainder no longer
 * needs -> write the whole thing to Postgres in one transaction.
 *
 * Postgres is the source of truth. If the transaction fails after the in-memory
 * mutation, the process is marked NOT ready (readiness probe fails) and the
 * caller gets a 503 — an operator/orchestrator restarts it and index.ts
 * rehydrates exactly from Postgres, which never recorded the bad trade. There
 * is deliberately no in-memory rollback; fail-stop is simpler to keep correct.
 */
export class TradingService {
  private locks = new Map<string, Promise<unknown>>();
  private degraded = false;

  constructor(
    private readonly exchange: ExchangeService,
    private readonly accounts: AccountService,
    private readonly db: PrismaClient,
  ) {}

  /** True once a write-through transaction has failed — the readiness probe should fail. */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** Run `fn` with exclusive access to a symbol's book + the accounts touching it. */
  private async withSymbolLock<T>(symbol: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(symbol) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(symbol, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(symbol) === next) this.locks.delete(symbol);
    }
  }

  async submitOrder(order: IncomingOrder): Promise<SubmitOutcome> {
    return this.withSymbolLock(order.symbol, async () => {
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
        result = await this.exchange.submitOrder(order); // match + Kafka publish + WS events
      } catch (err) {
        this.accounts.releaseOrder(order.id);
        throw err;
      }

      for (const trade of result.trades) this.accounts.settleTrade(trade);
      const restingRemaining = result.remainingOrder
        ? result.remainingOrder.quantity - result.remainingOrder.filledQuantity
        : 0;
      this.accounts.finalizeOrder(order.id, restingRemaining);

      const takerFilled = result.filledQuantity;
      const takerStatus = restingRemaining > 0 ? storedStatus(order, takerFilled) : terminalTakerStatus(order, takerFilled);

      const touched = new Set<string>([order.accountId]);
      for (const trade of result.trades) {
        touched.add(trade.buyAccountId);
        touched.add(trade.sellAccountId);
      }

      try {
        await this.db.$transaction(async (tx) => {
          await insertOrder(tx, order, takerFilled, takerStatus);
          for (const trade of result.trades) await insertTrade(tx, trade);
          for (const mf of result.makerFills) {
            await updateOrderFill(
              tx,
              mf.orderId,
              mf.filledQuantity,
              mf.filledQuantity + 1e-9 >= mf.totalQuantity ? 'FILLED' : 'PARTIALLY_FILLED',
            );
          }
          for (const id of touched) await writeAccountSnapshot(tx, this.accounts.snapshot(id));
        });
      } catch (err) {
        this.degraded = true;
        logger.fatal({ err, orderId: order.id }, 'write-through transaction failed — in-memory state is ahead of Postgres; restart to reconcile');
        return { status: 'error', reason: 'persistence failure' };
      }

      return { status: 'accepted', result };
    });
  }

  async cancelOrder(symbol: string, orderId: string, requesterAccountId: string): Promise<CancelOutcome> {
    return this.withSymbolLock(symbol, async () => {
      const owner = this.accounts.ownerOfOrder(orderId);
      if (owner && owner !== requesterAccountId) return { status: 'forbidden' };

      const removed = await this.exchange.cancelOrder(symbol, orderId);
      if (!removed) return { status: 'not_found' };

      this.accounts.releaseOrder(orderId);

      try {
        await this.db.$transaction(async (tx) => {
          await markOrderCancelled(tx, orderId);
          await writeAccountSnapshot(tx, this.accounts.snapshot(removed.accountId));
        });
      } catch (err) {
        this.degraded = true;
        logger.fatal({ err, orderId }, 'write-through transaction failed on cancel — restart to reconcile');
        return { status: 'error' };
      }

      return { status: 'cancelled', order: removed };
    });
  }

  getSnapshot(symbol: string) {
    return this.exchange.getSnapshot(symbol);
  }
}

/** Terminal status for a taker order that did not rest (fully filled, or a MARKET order that stopped). */
function terminalTakerStatus(order: IncomingOrder, filled: number): 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' {
  if (filled <= 1e-9) return 'REJECTED';
  return filled + 1e-9 >= order.quantity ? 'FILLED' : 'PARTIALLY_FILLED';
}

// Singleton wiring for this boilerplate.
export const tradingService = new TradingService(exchangeService, accountService, prisma);
