import { Router, Request, Response, NextFunction } from 'express';
import { accountService } from '../engine/AccountService';
import { prisma } from '../db/prisma';
import { writeAccountSnapshot } from '../db/persistence';
import { authenticate } from '../auth/apiKey';
import { createAccountSchema, depositSchema } from '../types/schemas';
import { logger } from '../logger';

export const accountsRouter = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

/**
 * POST /api/accounts — open an account. Returns the account view and a one-time
 * API key; the key is never shown again. Open (no auth) — this is how you get
 * your first key. The account is written to Postgres before we return; if that
 * write fails the in-memory account is rolled back and the caller gets a 503.
 */
accountsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { view, apiKey } = accountService.createAccount(parsed.data.name, parsed.data.startingCash ?? 0);
    try {
      await writeAccountSnapshot(prisma, accountService.snapshot(view.id));
    } catch (err) {
      accountService.forget(view.id);
      logger.error({ err }, 'failed to persist new account');
      return res.status(503).json({ error: 'Could not create account, please retry' });
    }
    return res.status(201).json({ account: view, apiKey });
  }),
);

/** GET /api/accounts/me — the authenticated account's balances and holdings. */
accountsRouter.get('/me', authenticate, (req: Request, res: Response) => {
  const view = accountService.getView(req.accountId as string);
  if (!view) return res.status(404).json({ error: 'Account not found' });
  return res.status(200).json(view);
});

/**
 * POST /api/accounts/me/deposit — fund the authenticated account with cash
 * and/or shares. A demo convenience, not a real settlement flow (see README).
 */
accountsRouter.post(
  '/me/deposit',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const accountId = req.accountId as string;
    const before = accountService.snapshot(accountId);
    const view = accountService.deposit(accountId, parsed.data);
    try {
      await writeAccountSnapshot(prisma, accountService.snapshot(accountId));
    } catch (err) {
      accountService.restore(before);
      logger.error({ err, accountId }, 'failed to persist deposit');
      return res.status(503).json({ error: 'Deposit not applied, please retry' });
    }
    return res.status(200).json(view);
  }),
);
