/**
 * In-memory stand-in for PrismaClient, good enough for the query shapes this
 * codebase uses. Supports the callback form of `$transaction` (no real
 * atomicity — writes just run sequentially against the same store).
 */

class FakeKnownRequestError extends Error {
  code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
  }
}

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && 'in' in (cond as object)) {
      return (cond as { in: unknown[] }).in.includes(row[field]);
    }
    return row[field] === cond;
  });
}

function sortRows(rows: Row[], orderBy: Row | undefined): Row[] {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
  return [...rows].sort((a, b) => {
    const av = a[field] as number | Date;
    const bv = b[field] as number | Date;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'desc' ? -cmp : cmp;
  });
}

export interface FakePrisma {
  client: {
    order: Record<string, (...args: never[]) => Promise<unknown>>;
    trade: Record<string, (...args: never[]) => Promise<unknown>>;
    account: Record<string, (...args: never[]) => Promise<unknown>>;
    position: Record<string, (...args: never[]) => Promise<unknown>>;
    $queryRaw: (...args: never[]) => Promise<unknown>;
    $transaction: (arg: unknown) => Promise<unknown>;
    $disconnect: () => Promise<void>;
  };
  stores: {
    orders: Map<string, Row>;
    trades: Map<string, Row>;
    accounts: Map<string, Row>;
    positions: Row[];
  };
  reset: () => void;
}

export function makeFakePrisma(): FakePrisma {
  const orders = new Map<string, Row>();
  const trades = new Map<string, Row>();
  const accounts = new Map<string, Row>();
  const positions: Row[] = []; // stable reference — mutated in place

  const client = {
    order: {
      create: async ({ data }: { data: Row }) => {
        if (orders.has(data.id as string)) throw new FakeKnownRequestError('P2002');
        orders.set(data.id as string, { ...data });
        return { ...data };
      },
      update: async ({ where: { id }, data }: { where: { id: string }; data: Row }) => {
        const row = orders.get(id);
        if (!row) throw new FakeKnownRequestError('P2025', 'record not found');
        Object.assign(row, data);
        return { ...row };
      },
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const row = orders.get(id);
        return row ? { ...row } : null;
      },
      findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) => {
        let rows = [...orders.values()].filter((r) => matchesWhere(r, where));
        rows = sortRows(rows, orderBy);
        if (take != null) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
    },
    trade: {
      create: async ({ data }: { data: Row }) => {
        if (trades.has(data.id as string)) throw new FakeKnownRequestError('P2002');
        trades.set(data.id as string, { ...data });
        return { ...data };
      },
      findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) => {
        let rows = [...trades.values()].filter((r) => matchesWhere(r, where));
        rows = sortRows(rows, orderBy);
        if (take != null) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
    },
    account: {
      upsert: async ({
        where: { id },
        create,
        update,
      }: {
        where: { id: string };
        create: Row;
        update: Row;
      }) => {
        const row = accounts.get(id);
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        accounts.set(id, { ...create });
        return { ...create };
      },
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const row = accounts.get(id);
        return row ? { ...row } : null;
      },
      findMany: async ({ include }: { include?: { positions?: boolean } } = {}) => {
        return [...accounts.values()].map((a) => ({
          ...a,
          ...(include?.positions ? { positions: positions.filter((p) => p.accountId === a.id).map((p) => ({ ...p })) } : {}),
        }));
      },
    },
    position: {
      deleteMany: async ({ where: { accountId } }: { where: { accountId: string } }) => {
        let count = 0;
        for (let i = positions.length - 1; i >= 0; i--) {
          if (positions[i].accountId === accountId) {
            positions.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        positions.push(...data.map((d) => ({ ...d })));
        return { count: data.length };
      },
      findMany: async ({ where }: { where?: Row } = {}) => positions.filter((p) => matchesWhere(p, where)).map((p) => ({ ...p })),
    },
    $queryRaw: async () => [{ ok: 1 }],
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(client);
      return Promise.all(arg as Promise<unknown>[]);
    },
    $disconnect: async () => undefined,
  };

  return {
    client: client as unknown as FakePrisma['client'],
    stores: { orders, trades, accounts, positions } as FakePrisma['stores'],
    reset: () => {
      orders.clear();
      trades.clear();
      accounts.clear();
      positions.length = 0;
    },
  };
}

export { FakeKnownRequestError };
