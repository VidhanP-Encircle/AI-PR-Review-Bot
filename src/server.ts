/**
 * @module server
 * Server Entry Point — Wires Fastify, BullMQ workers, and AI providers together.
 *
 * This is the Phase 2 server that:
 * 1. Starts a Fastify API server for webhook ingestion
 * 2. Connects to Redis and creates BullMQ queues
 * 3. Starts the Review Worker with the configured AI provider
 * 4. Handles graceful shutdown of all components
 *
 * Usage:
 *   npm run dev:server     # Development with hot reload
 *   npm run start:server   # Production start
 *
 * Prerequisites:
 *   - Redis running (via `docker compose up -d`)
 *   - Environment variables set (see .env.example)
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyRawBody from 'fastify-raw-body';

// Queue & Workers
import { createQueues } from './queue/queue-config.js';
import { createReviewWorker } from './queue/review-worker.js';

// Webhook Routes
import { registerWebhookRoutes } from './webhook/webhook-handler.js';

// Dashboard Routes
import { registerDashboardRoutes } from './api/routes.js';

// AI Provider Factory
import { createAIProvider } from './ai/ai-provider.factory.js';

// Observability
import { getLogger } from './utils/logger.js';
import { metricsRegistry, bullmqQueueSize } from './api/metrics.js';

const logger = getLogger('server');



/**
 * Bootstraps and starts the server.
 * Initializes Fastify, BullMQ queues, the review worker, and registers routes.
 */
async function bootstrap(): Promise<void> {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  logger.info('🚀 Starting AI PR Reviewer Bot Server...');

  if (process.env.GITHUB_APP_ID) {
    if (process.env.GITHUB_APP_PRIVATE_KEY_BASE64) {
      try {
        process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf-8');
      } catch (e) {
        logger.fatal('❌ GITHUB_APP_PRIVATE_KEY_BASE64 is malformed');
        process.exit(1);
      }
    }
    if (!process.env.GITHUB_APP_PRIVATE_KEY) {
      logger.fatal('❌ GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_BASE64 is missing');
      process.exit(1);
    }
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !process.env.GITHUB_WEBHOOK_SECRET) {
    logger.fatal('❌ GITHUB_WEBHOOK_SECRET is required in production');
    process.exit(1);
  } else if (!isProd && !process.env.GITHUB_WEBHOOK_SECRET) {
    logger.warn('⚠️ GITHUB_WEBHOOK_SECRET is not set. Webhook signatures will not be verified!');
  }

  // ── Step 1: Initialize Fastify ──────────────────────────────────────
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(isProd ? {} : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        }
      }),
    },
  });

  await app.register(cors, {
    origin: true, // required for credentials: true
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-github-event', 'x-github-delivery', 'x-hub-signature-256'],
  });

  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false, // Only on routes that need it
    encoding: 'utf8',
    runFirst: true,
  });

  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET || 'fallback-cookie-secret-for-dev',
    parseOptions: {} // options for parsing cookies
  });

  // ── Step 1.5: Security & Rate Limiting ──────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: isProd,
    global: true,
  });

  await app.register(rateLimit, {
    max: 100, // 100 requests per IP
    timeWindow: '1 minute',
  });

  app.setErrorHandler((error: any, request, reply) => {
    logger.error({ err: error, url: request.url }, 'Unhandled API Error');
    // Prevent stack trace leakage in production
    reply.status(error.statusCode || 500).send({ 
      error: isProd ? 'Internal Server Error' : error.message 
    });
  });

  // ── Step 2: Create BullMQ Queues ────────────────────────────────────
  logger.info('📦 Connecting to Redis and creating queues...');
  const queues = createQueues();
  logger.info('✅ Queues created: webhook, review, ai-chunk, publish');

  // ── Step 3: Resolve AI Provider ─────────────────────────────────────
  logger.info('🤖 Resolving AI provider...');
  const aiProvider = createAIProvider();
  logger.info(`✅ Provider: ${aiProvider.name} (${aiProvider.getConcurrencyStrategy()})`);

  // ── Step 4: Initialize Workers ──────────────────────────────────────
  logger.info('👷 Starting background workers...');
  
  const reviewWorker = createReviewWorker(aiProvider, queues);
  logger.info('✅ Review Worker started (listening on review-queue)');

  // ── Step 5: Register Routes ─────────────────────────────────────────
  registerWebhookRoutes(app, queues);
  registerDashboardRoutes(app, queues);

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', metricsRegistry.contentType);
    
    // Update queue size metrics before responding
    const reviewCounts = await queues.reviewQueue.getJobCounts();
    bullmqQueueSize.set({ queue_name: 'review', status: 'waiting' }, reviewCounts.waiting);
    bullmqQueueSize.set({ queue_name: 'review', status: 'active' }, reviewCounts.active);
    bullmqQueueSize.set({ queue_name: 'review', status: 'failed' }, reviewCounts.failed);
    
    return metricsRegistry.metrics();
  });

  // ── Step 6: Start Fastify Server ────────────────────────────────────
  try {
    await app.listen({ port, host });
    logger.info(`🌐 Server listening on http://${host}:${port}`);
    logger.info('📡 Webhook endpoint: POST /api/v1/webhooks/github');
    logger.info('💚 Health check:     GET  /api/v1/health');
    logger.info('📊 Metrics endpoint: GET  /metrics');
  } catch (error) {
    logger.fatal({ error }, '❌ Failed to start server');
    process.exit(1);
  }

  // ── Graceful Shutdown ───────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`🛑 Received ${signal}. Shutting down gracefully...`);

    // Close the worker first (let in-progress jobs finish)
    await reviewWorker.close();
    logger.info('✅ Review Worker stopped');

    // Close all queues
    await Promise.all([
      queues.webhookQueue.close(),
      queues.reviewQueue.close(),
      queues.aiChunkQueue.close(),
      queues.publishQueue.close(),
    ]);
    logger.info('✅ Queues closed');

    // Close Fastify
    await app.close();
    logger.info('✅ Server stopped');

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.fatal({ error }, '❌ Fatal error during bootstrap');
  process.exit(1);
});
