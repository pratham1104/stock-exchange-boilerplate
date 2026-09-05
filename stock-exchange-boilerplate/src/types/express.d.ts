/**
 * Populated by the `authenticate` middleware (src/auth/apiKey.ts) on routes
 * that require an API key. Undefined on unauthenticated routes.
 */
declare global {
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}

export {};
