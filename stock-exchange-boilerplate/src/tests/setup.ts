// Runs before any test module is imported. Provide harmless defaults for the
// required env vars so `src/config.ts` doesn't throw when a test doesn't need
// a real database or broker (they're mocked).
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.KAFKA_BROKER ??= 'localhost:59092';
process.env.LOG_LEVEL ??= 'silent';
process.env.NODE_ENV ??= 'test';
