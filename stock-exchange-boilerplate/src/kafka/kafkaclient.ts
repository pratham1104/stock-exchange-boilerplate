import { Kafka, logLevel } from 'kafkajs';
import { config } from '../config';

export const kafka = new Kafka({
  clientId: 'order-processing-app',
  brokers: [config.kafkaBroker],
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
};

// Single shared producer for the whole process; connected once at startup
// (see index.ts) and reused by ExchangeService for event publishing.
export const producer = kafka.producer({
  idempotent: true, // prevents duplicate messages on retries - exactly-once at the producer level
});

let producerConnected: Promise<void> | null = null;
let connectedFlag = false;

/** Connects the shared Kafka producer; safe to call multiple times. */
export function connectProducer(): Promise<void> {
  if (!producerConnected) {
    producerConnected = producer
      .connect()
      .then(() => {
        connectedFlag = true;
      })
      .catch((err) => {
        producerConnected = null; // allow a later retry
        throw err;
      });
  }
  return producerConnected;
}

/** Best-effort readiness signal for the health probe. */
export function isProducerConnected(): boolean {
  return connectedFlag;
}

/** Disconnects the shared Kafka producer during graceful shutdown. */
export async function disconnectProducer(): Promise<void> {
  if (producerConnected) {
    await producer.disconnect();
    producerConnected = null;
    connectedFlag = false;
  }
}
