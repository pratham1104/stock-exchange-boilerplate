import { config } from './config'; // validates env first — throws here if a required var is missing
import { createApp } from './app';
import { logger } from './logger';
import { prisma, pingDatabase } from './db/prisma';
import { connectProducer, disconnectProducer } from './kafka/kafkaclient';
import { attachMarketData } from './ws/marketData';
import { accountService } from './engine/AccountService';
import { exchangeService } from './engine/ExchangeService';
import { loadAccountSnapshots, loadOpenOrders } from './db/rehydrate';

const app = createApp();

/** Wait for Postgres to be reachable, retrying until the startup timeout. */
async function waitForDatabase(): Promise<void> {
  const deadline = Date.now() + config.startupDbTimeoutMs;
  for (;;) {
    if (await pingDatabase()) return;
    if (Date.now() > deadline) throw new Error(`Postgres not reachable within ${config.startupDbTimeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Rebuild the in-memory ledger and books from Postgres (the source of truth). */
async function rehydrate(): Promise<void> {
  const [accounts, openOrders] = await Promise.all([loadAccountSnapshots(prisma), loadOpenOrders(prisma)]);
  accountService.hydrate(accounts);
  exchangeService.hydrateBook(openOrders);
  for (const order of openOrders) accountService.rebuildReservation(order);
  logger.info({ accounts: accounts.length, openOrders: openOrders.length }, 'rehydrated from Postgres');
}

async function start(): Promise<void> {
  await waitForDatabase();
  await rehydrate();

  // Kafka publishing is best-effort; a broker outage must not stop the exchange.
  connectProducer().catch((err) => logger.warn({ err }, 'Kafka producer not connected — events will not publish'));

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Exchange API listening');
    logger.info(`Market-data WebSocket at ws://localhost:${config.port}/ws/market-data`);
  });

  const marketData = attachMarketData(server);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(); // stop accepting new connections
    marketData.close();
    await disconnectProducer().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    // Give in-flight requests a moment, then exit.
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
