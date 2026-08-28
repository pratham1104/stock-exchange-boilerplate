// Process entry point: loads .env, builds the app, and starts listening.
import 'dotenv/config';
import { createApp } from './app';
import { connectProducer, disconnectProducer } from './kafka/kafkaclient';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const app = createApp();

async function start() {
  await connectProducer();

  const server = app.listen(PORT, () => {
    console.log(`Exchange API listening on port ${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await disconnectProducer();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
