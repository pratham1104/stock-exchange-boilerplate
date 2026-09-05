import 'dotenv/config';

/**
 * Centralised, validated configuration. Reading process.env happens here and
 * nowhere else, so a missing/invalid required var fails the process at startup
 * with a clear message instead of surfacing as a mysterious runtime error.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intVar(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  kafkaBroker: string;
  /** Max order submissions per account per rolling minute. */
  orderRateLimitPerMinute: number;
  /** How long startup waits for Postgres before giving up (ms). */
  startupDbTimeoutMs: number;
  logLevel: string;
}

export const config: Config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: intVar('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  kafkaBroker: process.env.KAFKA_BROKER?.trim() || 'localhost:9094',
  orderRateLimitPerMinute: intVar('ORDER_RATE_LIMIT_PER_MINUTE', 120),
  startupDbTimeoutMs: intVar('STARTUP_DB_TIMEOUT_MS', 10_000),
  logLevel: process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
};
