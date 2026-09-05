import pino from 'pino';
import { config } from './config';

/**
 * One shared structured logger. In development it prints readable lines;
 * in production it emits JSON (one object per line) for log shippers.
 *
 * `pino-pretty` is loaded lazily and only in dev — it's an optional dev
 * dependency, so a missing install just falls back to JSON rather than crashing.
 */
function transport(): pino.TransportSingleOptions | undefined {
  if (config.nodeEnv === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  level: config.logLevel,
  transport: transport(),
});
