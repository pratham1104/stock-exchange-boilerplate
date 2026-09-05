// Example event-stream consumer. Postgres is the source of truth (the API
// write-throughs), so this process is NOT required for correctness — it's here
// to show how to consume the exchange event stream for a downstream concern
// (analytics, notifications, a fraud check, an external ticker, ...).
//
// Run separately: `npm run consumer`.
import './config';
import { ExchangeEvent } from './types/domain';
import { kafka, TOPICS } from './kafka/kafkaclient';
import { logger } from './logger';

const consumer = kafka.consumer({ groupId: 'exchange-events-example' });

function handle(event: ExchangeEvent): void {
  switch (event.type) {
    case 'OrderAccepted':
      logger.info(
        { orderId: event.order.id, symbol: event.order.symbol, side: event.order.side, qty: event.order.quantity, price: event.order.price },
        'OrderAccepted',
      );
      break;
    case 'TradeExecuted':
      logger.info(
        { tradeId: event.trade.id, symbol: event.trade.symbol, qty: event.trade.quantity, price: event.trade.price },
        'TradeExecuted',
      );
      break;
    case 'OrderCancelled':
      logger.info({ orderId: event.orderId, symbol: event.symbol }, 'OrderCancelled');
      break;
  }
}

async function start(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({ topics: Object.values(TOPICS), fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message }: { topic: string; message: { value: Buffer | null } }) => {
      if (!message.value) return;
      try {
        handle(JSON.parse(message.value.toString()) as ExchangeEvent);
      } catch (err) {
        logger.error({ err, topic }, 'failed to process message');
      }
    },
  });

  logger.info('exchange events example consumer running');

  const shutdown = async (): Promise<void> => {
    await consumer.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

start().catch((err) => {
  logger.fatal({ err }, 'failed to start consumer');
  process.exit(1);
});
