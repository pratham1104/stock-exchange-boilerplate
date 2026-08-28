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
