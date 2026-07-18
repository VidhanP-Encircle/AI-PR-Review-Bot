/**
 * @module queue/queue-config
 * BullMQ Queue Configuration and Connection Factory.
 *
 * Centralizes Redis connection settings and queue definitions
 * used across all background workers. Each queue maps to a
 * specific stage in the Review State Machine.
 *
 * @see 04_REVIEW_STATE_MACHINE.md for state definitions.
 * @see 03_SYSTEM_ARCHITECTURE.md Section 4.2 for queue topology.
 */

import { Queue, type ConnectionOptions } from 'bullmq';

/**
 * Queue names mapped to Review State Machine stages.
 * These are the logical channels that workers listen on.
 */
export const QUEUE_NAMES = {
  /** Webhook ingestion → Repository Ready */
  WEBHOOK: 'webhook-queue',
  /** Repository Ready → Context Generated (includes tech detection + rule engine) */
  REVIEW: 'review-queue',
  /** Context Generated → AI Reviewing (individual chunk analysis) */
  AI_CHUNK: 'ai-chunk-queue',
  /** Results Validated → Publishing */
  PUBLISH: 'publish-queue',
} as const;

/**
 * Builds the Redis connection options from environment variables.
 * Falls back to localhost:6379 for local development.
 *
 * @returns ConnectionOptions for BullMQ queues and workers.
 */
export function getRedisConnection(): ConnectionOptions {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
  };
}

/**
 * Creates all BullMQ queues with appropriate default settings.
 * These queues are used by the Fastify server to enqueue webhook events
 * and by workers to dispatch sub-tasks.
 *
 * @returns An object containing all queue instances.
 */
export function createQueues() {
  const connection = getRedisConnection();

  const webhookQueue = new Queue(QUEUE_NAMES.WEBHOOK, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
      removeOnFail: { count: 5000 },     // Keep last 5000 failed jobs
    },
  });

  const reviewQueue = new Queue(QUEUE_NAMES.REVIEW, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    },
  });

  const aiChunkQueue = new Queue(QUEUE_NAMES.AI_CHUNK, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 5000 },
    },
  });

  const publishQueue = new Queue(QUEUE_NAMES.PUBLISH, {
    connection,
    defaultJobOptions: {
      attempts: 5, // More retries for publishing (GitHub rate limits)
      backoff: { type: 'exponential', delay: 15000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    },
  });

  return { webhookQueue, reviewQueue, aiChunkQueue, publishQueue };
}

export type Queues = ReturnType<typeof createQueues>;
