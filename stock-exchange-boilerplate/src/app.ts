import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ordersRouter } from './routes/orders';
import { accountsRouter } from './routes/accounts';
import { healthRouter } from './routes/health';
import { logger } from './logger';

/**
 * Builds and configures the Express application.
 * Kept as a factory (rather than a module-level singleton) so tests can
 * spin up isolated app instances without touching a shared server.
 */
export function createApp(): Application {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.use(healthRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/orders', ordersRouter);

  // Catch-all for any route that didn't match above.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler — Express identifies this as an error handler by
  // its 4-arg signature, so it must stay last and keep the unused _next param.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, 'unhandled request error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
