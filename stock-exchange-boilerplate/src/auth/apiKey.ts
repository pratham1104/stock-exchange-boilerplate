import { Request, Response, NextFunction } from 'express';
import { accountService } from '../engine/AccountService';

/**
 * Bearer-token auth against AccountService's in-memory API-key index.
 * On success attaches `req.accountId`; otherwise responds 401 and stops.
 *
 * Keys live only in this process (see AccountService) — a restart invalidates
 * every key and callers must re-create their account. Fine for a boilerplate;
 * a real deployment would persist hashed keys and check them here.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    res.status(401).json({ error: 'Missing or malformed Authorization header (expected "Bearer <apiKey>")' });
    return;
  }

  const accountId = accountService.resolveApiKey(match[1].trim());
  if (!accountId) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  req.accountId = accountId;
  next();
}
