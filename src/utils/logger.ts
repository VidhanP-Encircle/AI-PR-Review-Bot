/**
 * @module utils/logger
 * Global Pino Logger Configuration.
 *
 * Uses pino-pretty in development for readable console output,
 * and standard JSON formatting in production for log aggregation.
 */

import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const lokiHost = process.env.LOKI_HOST || 'http://localhost:3100';

const targets: pino.TransportTargetOptions[] = [];

if (!isProd) {
  targets.push({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  });
}

// Always send logs to Loki
targets.push({
  target: 'pino-loki',
  options: {
    batching: true,
    interval: 5,
    host: lokiHost,
    labels: { application: 'ai-pr-reviewer' },
  },
});

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets,
  },
});

/**
 * Creates a child logger for a specific module or component.
 */
export function getLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}
