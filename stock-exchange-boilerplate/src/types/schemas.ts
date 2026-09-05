import { z } from 'zod';

/**
 * Request-body validation for POST /api/orders.
 * price is nullable to allow MARKET orders; the refine step enforces that
 * LIMIT orders must still provide one.
 */
export const placeOrderSchema = z.object({
  symbol: z.string().min(1).max(10),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']),
  price: z.number().positive().nullable(),
  quantity: z.number().int().positive(),
}).refine((data) => data.type === 'MARKET' || data.price !== null, {
  message: 'price is required for LIMIT orders',
  path: ['price'],
});

/** Inferred, validated shape of a place-order request body. */
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

/** POST /api/accounts — open a new account. */
export const createAccountSchema = z.object({
  name: z.string().min(1).max(60),
  startingCash: z.number().nonnegative().optional(),
});

/**
 * POST /api/accounts/me/deposit — fund a demo account with cash and/or shares.
 * At least one of `cash` or a `symbol`+`quantity` pair must be present.
 */
export const depositSchema = z
  .object({
    cash: z.number().positive().optional(),
    symbol: z.string().min(1).max(10).optional(),
    quantity: z.number().positive().optional(),
  })
  .refine((d) => d.cash != null || (d.symbol != null && d.quantity != null), {
    message: 'provide `cash`, or both `symbol` and `quantity`',
  })
  .refine((d) => (d.symbol == null) === (d.quantity == null), {
    message: '`symbol` and `quantity` must be given together',
  });
