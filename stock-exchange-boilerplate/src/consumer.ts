// Standalone process entry point for consuming exchange events off Kafka.
// Runs separately from the API process (src/index.ts) — start with `npm run consumer`.
import 'dotenv/config';
import { ExchangeEvent } from './types/domain';
import { kafka, TOPICS } from './kafka/kafkaclient';
import { persistExchangeEvent } from './db/persistExchangeEvent';
import { prisma } from './db/prisma';

const consumer = kafka.consumer({ groupId: 'exchange-events-consumer' });

function logEvent(event: ExchangeEvent) {
  switch (event.type) {
    case 'OrderAccepted':
      console.log(`[OrderAccepted] ${event.order.id} ${event.order.symbol} ${event.order.side} ${event.order.quantity}@${event.order.price ?? 'MARKET'}`);
      break;
    case 'TradeExecuted':
      console.log(`[TradeExecuted] ${event.trade.id} ${event.trade.symbol} ${event.trade.quantity}@${event.trade.price} (buy=${event.trade.buyOrderId} sell=${event.trade.sellOrderId})`);
      break;
    case 'OrderCancelled':
      console.log(`[OrderCancelled] ${event.orderId} ${event.symbol}`);
      break;
    case 'AccountUpdated':
      console.log(
        `[AccountUpdated] ${event.account.id} (${event.reason}) cash=${event.account.cashBalance} positions=${event.account.positions.length}`,
      );
      break;
  }
}

async function start() {
  await consumer.connect();
  // This consumer maintains a materialized read model in Postgres, so a
  // fresh consumer group must replay the full event log to reconstruct
  // state rather than starting from "latest" and missing prior orders.
  await consumer.subscribe({ topics: Object.values(TOPICS), fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message }: { topic: string; message: { value: Buffer | null } }) => {
      if (!message.value) return;
      try {
        const event = JSON.parse(message.value.toString()) as ExchangeEvent;
        logEvent(event);
        await persistExchangeEvent(event);
      } catch (err) {
        console.error(`Failed to process message from ${topic}`, err);
      }
    },
  });

  console.log('Exchange events consumer running');

  const shutdown = async () => {
    await consumer.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('Failed to start consumer', err);
  process.exit(1);
});
