import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { AccountView, IncomingOrder, Position, Trade } from '../types/domain';
import { producer, TOPICS } from '../kafka/kafkaclient';

const EPSILON = 1e-9;

/** Thrown by reserveForOrder when the account can't cover the order. Caught and turned into a 422. */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

interface Holding {
  quantity: number; // total owned
  reserved: number; // held against open sell orders
}

interface InternalAccount {
  id: string;
  name: string;
  apiKey: string;
  cash: number; // spendable
  reservedCash: number; // held against open buy orders
  holdings: Map<string, Holding>;
}

/**
 * Per-order reservation, drawn down as the order fills and released on cancel
 * or when a resting remainder needs less than was reserved. `perShareCash` is
 * fixed at reservation time so partial fills draw down evenly.
 */
interface Reservation {
  accountId: string;
  side: 'BUY' | 'SELL';
  symbol: string;
  cash: number; // remaining reserved cash (BUY)
  perShareCash: number; // cash reserved per share (BUY)
  shares: number; // remaining reserved shares (SELL)
}

export interface AccountServiceEvents {
  account: (view: AccountView) => void;
}

/**
 * In-memory, authoritative ledger — accounts, cash, holdings, and the
 * reservations backing open orders. Mirrors OrderBook/ExchangeService: fast
 * synchronous truth here, with an AccountUpdated event published to Kafka for
 * the durable Postgres read model.
 *
 * Accounts (and their API keys) live only in this process and are lost on
 * restart — the same tradeoff as the in-memory book. Documented in the README.
 */
export class AccountService extends EventEmitter {
  private accounts = new Map<string, InternalAccount>();
  private apiKeyIndex = new Map<string, string>(); // apiKey -> accountId
  private reservations = new Map<string, Reservation>(); // orderId -> reservation

  on<K extends keyof AccountServiceEvents>(event: K, listener: AccountServiceEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof AccountServiceEvents>(event: K, ...args: Parameters<AccountServiceEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  private require(accountId: string): InternalAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Unknown account ${accountId}`);
    return account;
  }

  private holding(account: InternalAccount, symbol: string): Holding {
    let h = account.holdings.get(symbol);
    if (!h) {
      h = { quantity: 0, reserved: 0 };
      account.holdings.set(symbol, h);
    }
    return h;
  }

  private toView(account: InternalAccount): AccountView {
    const positions: Position[] = [...account.holdings.entries()]
      .filter(([, h]) => h.quantity > EPSILON)
      .map(([symbol, h]) => ({ symbol, quantity: h.quantity }));
    return {
      id: account.id,
      name: account.name,
      cashBalance: account.cash,
      reservedCash: account.reservedCash,
      positions,
    };
  }

  private async announce(account: InternalAccount, reason: 'created' | 'deposit' | 'settlement'): Promise<void> {
    const view = this.toView(account);
    this.emit('account', view);
    try {
      await producer.send({
        topic: TOPICS.ACCOUNT_UPDATED,
        messages: [
          {
            key: account.id,
            value: JSON.stringify({
              type: 'AccountUpdated',
              account: { id: account.id, name: account.name, cashBalance: account.cash, positions: view.positions },
              reason,
              timestamp: Date.now(),
            }),
          },
        ],
      });
    } catch (err) {
      console.error('Failed to publish AccountUpdated', err);
    }
  }

  // ---- lifecycle --------------------------------------------------------

  async createAccount(name: string, startingCash = 0): Promise<{ view: AccountView; apiKey: string }> {
    const id = randomUUID();
    const apiKey = randomUUID();
    const account: InternalAccount = { id, name, apiKey, cash: startingCash, reservedCash: 0, holdings: new Map() };
    this.accounts.set(id, account);
    this.apiKeyIndex.set(apiKey, id);
    await this.announce(account, 'created');
    return { view: this.toView(account), apiKey };
  }

  resolveApiKey(apiKey: string): string | null {
    return this.apiKeyIndex.get(apiKey) ?? null;
  }

  getView(accountId: string): AccountView | null {
    const account = this.accounts.get(accountId);
    return account ? this.toView(account) : null;
  }

  /** Fund a demo account with cash and/or shares. Not a real settlement flow — see README. */
  async deposit(
    accountId: string,
    deposit: { cash?: number; symbol?: string; quantity?: number },
  ): Promise<AccountView> {
    const account = this.require(accountId);
    if (deposit.cash != null) {
      if (deposit.cash <= 0) throw new Error('cash deposit must be positive');
      account.cash += deposit.cash;
    }
    if (deposit.symbol != null && deposit.quantity != null) {
      if (deposit.quantity <= 0) throw new Error('share deposit must be positive');
      this.holding(account, deposit.symbol).quantity += deposit.quantity;
    }
    await this.announce(account, 'deposit');
    return this.toView(account);
  }

  // ---- reservations & settlement -------------------------------------

  /**
   * Reserve funds/shares for an order before it hits the matching engine.
   * `estimatedCost` is only consulted for MARKET buys (which have no limit
   * price to reserve against) — the caller computes it by sweeping the book.
   * Throws InsufficientFundsError if the account can't cover the order.
   */
  reserveForOrder(order: IncomingOrder, estimatedCost: number): void {
    const account = this.require(order.accountId);

    if (order.side === 'BUY') {
      const needed = order.type === 'LIMIT' ? (order.price as number) * order.quantity : estimatedCost;
      const reservedShares = order.type === 'LIMIT' ? order.quantity : estimatedCost > EPSILON ? order.quantity : 0;
      if (needed > account.cash + EPSILON) {
        throw new InsufficientFundsError(
          `account has ${account.cash.toFixed(2)} available, order needs ${needed.toFixed(2)}`,
        );
      }
      account.cash -= needed;
      account.reservedCash += needed;
      this.reservations.set(order.id, {
        accountId: order.accountId,
        side: 'BUY',
        symbol: order.symbol,
        cash: needed,
        perShareCash: reservedShares > 0 ? needed / reservedShares : 0,
        shares: 0,
      });
      return;
    }

    const holding = this.holding(account, order.symbol);
    const available = holding.quantity - holding.reserved;
    if (order.quantity > available + EPSILON) {
      throw new InsufficientFundsError(
        `account has ${available} ${order.symbol} available, order needs ${order.quantity}`,
      );
    }
    holding.reserved += order.quantity;
    this.reservations.set(order.id, {
      accountId: order.accountId,
      side: 'SELL',
      symbol: order.symbol,
      cash: 0,
      perShareCash: 0,
      shares: order.quantity,
    });
  }

  /** Move cash and shares between the two accounts for one fill, drawing down both reservations. */
  settleTrade(trade: Trade): void {
    const buyRes = this.reservations.get(trade.buyOrderId);
    const sellRes = this.reservations.get(trade.sellOrderId);
    if (!buyRes || !sellRes) throw new Error(`settleTrade: missing reservation for trade ${trade.id}`);

    const buyer = this.require(trade.buyAccountId);
    const seller = this.require(trade.sellAccountId);
    const actualCost = trade.price * trade.quantity;

    // Buyer: consume reserved cash, refund the gap vs. actual price, receive shares.
    const drawn = Math.min(buyRes.perShareCash * trade.quantity, buyRes.cash);
    buyer.reservedCash -= drawn;
    buyer.cash += drawn - actualCost;
    buyRes.cash -= drawn;
    this.holding(buyer, trade.symbol).quantity += trade.quantity;

    // Seller: release reserved shares, receive proceeds.
    const sellerHolding = this.holding(seller, trade.symbol);
    sellerHolding.quantity -= trade.quantity;
    sellerHolding.reserved -= trade.quantity;
    seller.cash += actualCost;
    sellRes.shares -= trade.quantity;

    this.dropReservationIfDrained(trade.buyOrderId);
    this.dropReservationIfDrained(trade.sellOrderId);
  }

  private dropReservationIfDrained(orderId: string): void {
    const res = this.reservations.get(orderId);
    if (res && res.cash <= EPSILON && res.shares <= EPSILON) this.reservations.delete(orderId);
  }

  /**
   * Called once matching is done for the incoming (taker) order. Releases any
   * reservation it no longer needs: everything if it fully filled or didn't
   * rest, otherwise the excess above what the resting remainder requires.
   */
  finalizeOrder(orderId: string, restingRemainingQty: number): void {
    const res = this.reservations.get(orderId);
    if (!res) return;
    const account = this.require(res.accountId);

    if (res.side === 'BUY') {
      const keep = res.perShareCash * restingRemainingQty;
      const release = res.cash - keep;
      if (release > EPSILON) {
        account.reservedCash -= release;
        account.cash += release;
        res.cash = keep;
      }
    } else {
      const release = res.shares - restingRemainingQty;
      if (release > EPSILON) {
        this.holding(account, res.symbol).reserved -= release;
        res.shares = restingRemainingQty;
      }
    }

    if (restingRemainingQty <= EPSILON) this.reservations.delete(orderId);
  }

  /** Account that owns the open order with this id, or null if there's no open reservation for it. */
  ownerOfOrder(orderId: string): string | null {
    return this.reservations.get(orderId)?.accountId ?? null;
  }

  /** Cancel path: hand back everything still reserved for the order. */
  releaseOrder(orderId: string): void {
    const res = this.reservations.get(orderId);
    if (!res) return;
    const account = this.require(res.accountId);

    if (res.side === 'BUY' && res.cash > EPSILON) {
      account.reservedCash -= res.cash;
      account.cash += res.cash;
    } else if (res.side === 'SELL' && res.shares > EPSILON) {
      this.holding(account, res.symbol).reserved -= res.shares;
    }
    this.reservations.delete(orderId);
  }

  /** Publish an account's current settled state (used after a batch of settlements). */
  async publishState(accountId: string, reason: 'settlement' | 'deposit' | 'created' = 'settlement'): Promise<void> {
    const account = this.accounts.get(accountId);
    if (account) await this.announce(account, reason);
  }
}

// Singleton for this boilerplate. Swap for DI if the app grows.
export const accountService = new AccountService();
