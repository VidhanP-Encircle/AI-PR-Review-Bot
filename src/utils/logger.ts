/**
 * @module utils/logger
 * Global Pino Logger Configuration.
 *
 * Uses pino-pretty in development for readable console output,
 * and standard JSON formatting in production.
 */

import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

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

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: targets.length > 0 ? { targets } : undefined,
});

/**
 * Creates a child logger for a specific module or component.
 */
export function getLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}
