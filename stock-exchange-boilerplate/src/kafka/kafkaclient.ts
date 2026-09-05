import { Kafka, logLevel } from 'kafkajs';

export const kafka = new Kafka({
  clientId: 'order-processing-app',
  brokers: [process.env.KAFKA_BROKER || 'localhost:9094'],
  logLevel: logLevel.ERROR, // keep console clean, we log our own stuff
  retry: {
    initialRetryTime: 300,
    retries: 5,
  },
});

export const TOPICS = {
  ORDER_ACCEPTED: 'order.accepted',
  TRADE_EXECUTED: 'trade.executed',
  ORDER_CANCELLED: 'order.cancelled',
  ACCOUNT_UPDATED: 'account.updated',
};

// Single shared producer for the whole process; connected once at startup
// (see index.ts) and reused by ExchangeService for event publishing.
export const producer = kafka.producer({
  idempotent: true, // prevents duplicate messages on retries - exactly-once at the producer level
});

let producerConnected: Promise<void> | null = null;

/** Connects the shared Kafka producer; safe to call multiple times. */
export function connectProducer(): Promise<void> {
  if (!producerConnected) {
    producerConnected = producer.connect();
  }
  return producerConnected;
}

/** Disconnects the shared Kafka producer during graceful shutdown. */
export async function disconnectProducer(): Promise<void> {
  if (producerConnected) {
    await producer.disconnect();
    producerConnected = null;
  }
}
