import { Router, Request, Response, NextFunction } from 'express';
import { accountService } from '../engine/AccountService';
import { authenticate } from '../auth/apiKey';
import { createAccountSchema, depositSchema } from '../types/schemas';

export const accountsRouter = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

/**
 * POST /api/accounts — open an account. Returns the account view and a one-time
 * API key; the key is never shown again, so the caller must store it. Open
 * (no auth) — this is how you get your first key.
 */
accountsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { view, apiKey } = await accountService.createAccount(parsed.data.name, parsed.data.startingCash ?? 0);
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
    const view = await accountService.deposit(req.accountId as string, parsed.data);
    return res.status(200).json(view);
  }),
);
