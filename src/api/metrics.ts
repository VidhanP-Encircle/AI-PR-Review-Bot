/**
 * @module api/metrics
 * Prometheus Metrics Exporter.
 *
 * Defines custom Prometheus metrics to track AI PR Reviewer behavior,
 * costs, queue latency, and system health.
 */

import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, Event Loop Lag)
collectDefaultMetrics({ register: metricsRegistry });

// ── Custom Metrics ───────────────────────────────────────────────────

export const prReviewsTotal = new Counter({
  name: 'ai_reviewer_pr_reviews_total',
  help: 'Total number of PR reviews processed',
  labelNames: ['status'], // e.g., 'completed', 'failed'
  registers: [metricsRegistry],
});

export const aiInferenceDuration = new Histogram({
  name: 'ai_reviewer_inference_duration_seconds',
  help: 'Time spent in AI inference per chunk',
  labelNames: ['provider', 'model'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

export const aiTokensTotal = new Counter({
  name: 'ai_reviewer_tokens_total',
  help: 'Total tokens used by AI inference',
  labelNames: ['provider', 'type'], // type: 'input' or 'output'
  registers: [metricsRegistry],
});

export const aiCostUsdTotal = new Counter({
  name: 'ai_reviewer_cost_usd_total',
  help: 'Total estimated cost in USD for AI inference',
  labelNames: ['provider'],
  registers: [metricsRegistry],
});

export const bullmqQueueSize = new Gauge({
  name: 'ai_reviewer_queue_size',
  help: 'Number of jobs currently in BullMQ queues',
  labelNames: ['queue_name', 'status'], // status: 'waiting', 'active', 'failed'
  registers: [metricsRegistry],
});

export const findingsTotal = new Counter({
  name: 'ai_reviewer_findings_total',
  help: 'Total number of findings generated, categorized by status',
  labelNames: ['status'], // 'PENDING', 'ACCEPTED', 'REJECTED'
  registers: [metricsRegistry],
});
