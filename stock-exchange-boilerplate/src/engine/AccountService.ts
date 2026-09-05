import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
import { AccountView, IncomingOrder, Position, RestingOrder, Trade } from '../types/domain';
import { AccountSnapshot } from '../db/persistence';

const EPSILON = 1e-9;

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** Thrown by reserveForOrder when the account can't cover the order. Caught and turned into a 422. */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

interface Holding {
  quantity: number; // total shares owned (settled)
  reserved: number; // held against open sell orders
}

interface InternalAccount {
  id: string;
  name: string;
  apiKeyHash: string;
  settledCash: number; // gross cash — NOT reduced by open buy-order reservations
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
 * In-memory ledger — accounts, settled cash, holdings, and the reservations
 * backing open orders. Postgres is the source of truth; this is a fast cache
 * that TradingService keeps write-through-consistent with the database and
 * that index.ts rebuilds via hydrate() on startup.
 *
 * Cash model: `settledCash` is real money the account holds. `reservedCash` is
 * a lien from open buy orders. Spendable = settledCash - reservedCash. Only
 * settledCash is persisted; reservations are re-derived from the open Order
 * rows on restart (rebuildReservation).
 *
 * API keys are never stored — only sha256(key). The raw key is returned once
 * from createAccount and never again.
 */
export class AccountService extends EventEmitter {
  private accounts = new Map<string, InternalAccount>();
  private hashIndex = new Map<string, string>(); // apiKeyHash -> accountId
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

  private spendable(account: InternalAccount): number {
    return account.settledCash - account.reservedCash;
  }

  private positionsOf(account: InternalAccount): Position[] {
    return [...account.holdings.entries()]
      .filter(([, h]) => h.quantity > EPSILON)
      .map(([symbol, h]) => ({ symbol, quantity: h.quantity }));
  }

  private toView(account: InternalAccount): AccountView {
    return {
      id: account.id,
      name: account.name,
      cashBalance: this.spendable(account),
      reservedCash: account.reservedCash,
      positions: this.positionsOf(account),
    };
  }

  private announce(account: InternalAccount): void {
    this.emit('account', this.toView(account));
  }

  // ---- lifecycle & persistence bridge ---------------------------------

  /** Creates an account in memory and returns the one-time raw API key. Caller must persist the snapshot. */
  createAccount(name: string, startingCash = 0): { view: AccountView; apiKey: string } {
    const id = randomUUID();
    const apiKey = randomUUID();
    const apiKeyHash = hashApiKey(apiKey);
    const account: InternalAccount = {
      id,
      name,
      apiKeyHash,
      settledCash: startingCash,
      reservedCash: 0,
      holdings: new Map(),
    };
    this.accounts.set(id, account);
    this.hashIndex.set(apiKeyHash, id);
    this.announce(account);
    return { view: this.toView(account), apiKey };
  }

  /** Drop an account from memory — used to roll back a create whose DB write failed. */
  forget(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.hashIndex.delete(account.apiKeyHash);
    this.accounts.delete(accountId);
  }

  resolveApiKey(rawKey: string): string | null {
    return this.hashIndex.get(hashApiKey(rawKey)) ?? null;
  }

  getView(accountId: string): AccountView | null {
    const account = this.accounts.get(accountId);
    return account ? this.toView(account) : null;
  }

  /** Full persistable state of one account (settled cash + holdings). */
  snapshot(accountId: string): AccountSnapshot {
    const account = this.require(accountId);
    return {
      id: account.id,
      name: account.name,
      apiKeyHash: account.apiKeyHash,
      cashBalance: account.settledCash,
      positions: this.positionsOf(account),
    };
  }

  /** Replace one account's state from a snapshot — used for hydration and for rolling back a failed write. */
  restore(snap: AccountSnapshot): void {
    const existing = this.accounts.get(snap.id);
    const reservedCash = existing?.reservedCash ?? 0;
    const holdings = new Map<string, Holding>();
    for (const p of snap.positions) {
      holdings.set(p.symbol, { quantity: p.quantity, reserved: existing?.holdings.get(p.symbol)?.reserved ?? 0 });
    }
    // keep zero-quantity holdings that still carry a reservation
    if (existing) {
      for (const [symbol, h] of existing.holdings) {
        if (!holdings.has(symbol) && h.reserved > EPSILON) holdings.set(symbol, { quantity: 0, reserved: h.reserved });
      }
    }
    const account: InternalAccount = {
      id: snap.id,
      name: snap.name,
      apiKeyHash: snap.apiKeyHash,
      settledCash: snap.cashBalance,
      reservedCash,
      holdings,
    };
    if (existing && existing.apiKeyHash !== snap.apiKeyHash) this.hashIndex.delete(existing.apiKeyHash);
    this.accounts.set(snap.id, account);
    this.hashIndex.set(snap.apiKeyHash, snap.id);
  }

  /** Bulk-load accounts from Postgres on startup. Clears any prior in-memory state. */
  hydrate(snapshots: AccountSnapshot[]): void {
    this.accounts.clear();
    this.hashIndex.clear();
    this.reservations.clear();
    for (const snap of snapshots) this.restore(snap);
  }

  /** Fund a demo account with cash and/or shares. Not a real settlement flow — see README. Caller must persist. */
  deposit(accountId: string, deposit: { cash?: number; symbol?: string; quantity?: number }): AccountView {
    const account = this.require(accountId);
    if (deposit.cash != null) {
      if (deposit.cash <= 0) throw new Error('cash deposit must be positive');
      account.settledCash += deposit.cash;
    }
    if (deposit.symbol != null && deposit.quantity != null) {
      if (deposit.quantity <= 0) throw new Error('share deposit must be positive');
      this.holding(account, deposit.symbol).quantity += deposit.quantity;
    }
    this.announce(account);
    return this.toView(account);
  }

  // ---- reservations & settlement -------------------------------------

  /**
   * Reserve funds/shares for a new order before it hits the matching engine.
   * `estimatedCost` is only consulted for MARKET buys (no limit price to
   * reserve against). Throws InsufficientFundsError if the account can't cover it.
   */
  reserveForOrder(order: IncomingOrder, estimatedCost: number): void {
    const account = this.require(order.accountId);

    if (order.side === 'BUY') {
      const needed = order.type === 'LIMIT' ? (order.price as number) * order.quantity : estimatedCost;
      const reservedShares = order.type === 'LIMIT' ? order.quantity : estimatedCost > EPSILON ? order.quantity : 0;
      if (needed > this.spendable(account) + EPSILON) {
        throw new InsufficientFundsError(
          `account has ${this.spendable(account).toFixed(2)} available, order needs ${needed.toFixed(2)}`,
        );
      }
      account.reservedCash += needed;
      this.reservations.set(order.id, {
        accountId: order.accountId,
        side: 'BUY',
        symbol: order.symbol,
        cash: needed,
        perShareCash: reservedShares > 0 ? needed / reservedShares : 0,
        shares: 0,
      });
      this.announce(account);
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
    this.announce(account);
  }

  /**
   * Rebuild the reservation for an order that was already resting before a
   * restart. No funds check — the lien was committed pre-crash and `settledCash`
   * loaded from Postgres already reflects every fill that settled.
   */
  rebuildReservation(order: RestingOrder): void {
    const account = this.require(order.accountId);
    const remaining = order.quantity - order.filledQuantity;
    if (remaining <= EPSILON) return;

    if (order.side === 'BUY') {
      const price = order.price as number;
      const cash = price * remaining;
      account.reservedCash += cash;
      this.reservations.set(order.id, {
        accountId: order.accountId,
        side: 'BUY',
        symbol: order.symbol,
        cash,
        perShareCash: price,
        shares: 0,
      });
    } else {
      this.holding(account, order.symbol).reserved += remaining;
      this.reservations.set(order.id, {
        accountId: order.accountId,
        side: 'SELL',
        symbol: order.symbol,
        cash: 0,
        perShareCash: 0,
        shares: remaining,
      });
    }
  }

  /** Move cash and shares between the two accounts for one fill, drawing down both reservations. */
  settleTrade(trade: Trade): void {
    const buyRes = this.reservations.get(trade.buyOrderId);
    const sellRes = this.reservations.get(trade.sellOrderId);
    if (!buyRes || !sellRes) throw new Error(`settleTrade: missing reservation for trade ${trade.id}`);

    const buyer = this.require(trade.buyAccountId);
    const seller = this.require(trade.sellAccountId);
    const actualCost = trade.price * trade.quantity;

    // Buyer: consume reserved cash lien, pay the real cost, receive shares.
    const drawn = Math.min(buyRes.perShareCash * trade.quantity, buyRes.cash);
    buyer.reservedCash -= drawn; // release the lien for these shares
    buyer.settledCash -= actualCost; // real money leaves (drawn - actualCost stays as spendable = the limit-vs-fill refund)
    buyRes.cash -= drawn;
    this.holding(buyer, trade.symbol).quantity += trade.quantity;

    // Seller: release reserved shares, receive proceeds.
    const sellerHolding = this.holding(seller, trade.symbol);
    sellerHolding.quantity -= trade.quantity;
    sellerHolding.reserved -= trade.quantity;
    seller.settledCash += actualCost;
    sellRes.shares -= trade.quantity;

    this.dropReservationIfDrained(trade.buyOrderId);
    this.dropReservationIfDrained(trade.sellOrderId);

    this.announce(buyer);
    this.announce(seller);
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
    this.announce(account);
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
    } else if (res.side === 'SELL' && res.shares > EPSILON) {
      this.holding(account, res.symbol).reserved -= res.shares;
    }
    this.reservations.delete(orderId);
    this.announce(account);
  }
}

// Singleton for this boilerplate. Swap for DI if the app grows.
export const accountService = new AccountService();
