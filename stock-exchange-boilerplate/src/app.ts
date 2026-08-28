import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ordersRouter } from './routes/orders';

/**
 * Builds and configures the Express application.
 * Kept as a factory (rather than a module-level singleton) so tests can
 * spin up isolated app instances without touching a shared server.
 */
export function createApp(): Application {
  const app = express();

  // Security headers, permissive CORS, and JSON body parsing for all routes.
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Basic liveness probe for load balancers / uptime checks.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
  });

  app.use('/api/orders', ordersRouter);

  // Catch-all for any route that didn't match above.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler — Express identifies this as an error handler by
  // its 4-arg signature, so it must stay last and keep the unused _next param.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
