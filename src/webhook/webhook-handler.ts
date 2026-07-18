/**
 * @module webhook/webhook-handler
 * Fastify Webhook Route Handler.
 *
 * Handles incoming webhook events from GitHub (and future GitLab support).
 * Validates HMAC signatures, normalizes payloads via the GitPlatformAdapter,
 * and enqueues review jobs into BullMQ.
 *
 * @see 06_GIT_INTEGRATION_AND_WEBHOOKS.md for webhook architecture.
 * @see 10_API_SPECIFICATION.md Section 4.1 for API spec.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GitHubAdapter } from '../adapters/github.adapter.js';
import type { Queues } from '../queue/queue-config.js';
import { prisma } from '../db/prisma.js';
import { getLogger } from '../utils/logger.js';
import { findingsTotal } from '../api/metrics.js';

const logger = getLogger('webhook');

/**
 * Verifies the HMAC SHA-256 signature from a GitHub webhook.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param payload - The raw request body string.
 * @param signature - The `x-hub-signature-256` header value.
 * @param secret - The webhook secret configured in GitHub.
 * @returns True if the signature is valid.
 */
function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * Registers the webhook routes on a Fastify instance.
 *
 * Routes:
 * - POST /api/v1/webhooks/github — Receives GitHub webhook events
 * - GET  /api/v1/health           — Health check endpoint
 *
 * @param app - The Fastify instance.
 * @param queues - The BullMQ queue instances for job dispatch.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  queues: Queues
): void {
  // ── Health Check ─────────────────────────────────────────────────────
  app.get('/api/v1/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.2.0',
    });
  });

  // ── GitHub Webhook Handler ───────────────────────────────────────────
  app.post('/api/v1/webhooks/github', {
    config: {
      rawBody: true,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    // Step 1: Validate HMAC signature (if secret is configured)
    if (webhookSecret) {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;

      if (!signature) {
        logger.warn('Missing x-hub-signature-256 header');
        return reply.status(401).send({ error: 'Missing signature' });
      }

      // Use request.rawBody string provided by fastify-raw-body
      const rawBody = (request as any).rawBody;
      if (typeof rawBody !== 'string') {
        logger.error('fastify-raw-body did not populate request.rawBody as a string');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
      
      if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
        logger.warn('Invalid HMAC signature');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    // Step 2: Handle GitHub App installation events
    const eventType = request.headers['x-github-event'] as string | undefined;

    if (eventType === 'installation') {
      const data = request.body as { 
        action?: string; 
        installation?: { id: number; account: { id: number; login: string } } 
      };
      if (data.action === 'created' || data.action === 'new_permissions_accepted') {
        logger.info({ installationId: data.installation?.id }, `GitHub App installation event: ${data.action}`);
        if (data.installation) {
          await prisma.organization.upsert({
            where: { id: String(data.installation.account.id) },
            update: { githubInstallationId: String(data.installation.id), name: data.installation.account.login },
            create: {
              id: String(data.installation.account.id),
              name: data.installation.account.login,
              githubInstallationId: String(data.installation.id)
            }
          });
        }
        return reply.status(200).send({ status: 'ok' });
      } else if (data.action === 'deleted' || data.action === 'suspend') {
        logger.info({ installationId: data.installation?.id }, `GitHub App installation event: ${data.action}`);
        if (data.installation) {
          await prisma.organization.updateMany({
            where: { id: String(data.installation.account.id) },
            data: { githubInstallationId: null }
          });
        }
        return reply.status(200).send({ status: 'ok' });
      }
    } // Step 3: Filter event type — only process pull_request and pull_request_review_comment events
    if (eventType !== 'pull_request' && eventType !== 'pull_request_review_comment') {
      logger.info({ eventType }, `Ignoring event type: ${eventType}`);
      return reply.status(200).send({ status: 'ignored', event: eventType });
    }

    // Step 3.5: Handle PR Review Comments (Feedback Loop)
    if (eventType === 'pull_request_review_comment') {
      const data = request.body as any;
      if (data.action === 'created') {
        const bodyText = data.comment?.body || '';
        const match = bodyText.match(/Reject:\s*(.+)/i);
        
        if (match) {
          const feedbackReason = match[1].trim();
          const repoId = String(data.repository?.id);
          const prNumber = data.pull_request?.number;
          const filePath = data.comment?.path;
          const lineNumber = data.comment?.original_line || data.comment?.line; // fallback to line if original_line is missing

          logger.info({ repoId, prNumber, filePath, lineNumber, feedbackReason }, 'Received REJECT feedback via GitHub comment');

          if (repoId && prNumber && filePath && lineNumber) {
            try {
              // Find the repository and PR
              const repo = await prisma.repository.findUnique({ where: { githubId: repoId } });
              if (repo) {
                const pr = await prisma.pullRequest.findUnique({
                  where: { repositoryId_prNumber: { repositoryId: repo.id, prNumber: prNumber } }
                });
                
                if (pr) {
                  // Find all findings that match this file and line and mark them rejected
                  const updated = await prisma.reviewFinding.updateMany({
                    where: {
                      pullRequestId: pr.id,
                      filePath: filePath,
                      lineNumber: lineNumber,
                    },
                    data: {
                      status: 'REJECTED',
                      feedbackReason: feedbackReason,
                    },
                  });
                  logger.info({ updatedCount: updated.count }, `Marked findings as REJECTED`);
                  if (updated.count > 0) {
                    findingsTotal.inc({ status: 'REJECTED' }, updated.count);
                  }
                }
              }
            } catch (err) {
              logger.error({ err }, 'Failed to update finding status from review comment');
            }
          }
        }
      }
      return reply.status(200).send({ status: 'ok' });
    }

    // Step 4: Parse and normalize the webhook payload for PR events
    const githubAdapter = new GitHubAdapter(process.env.GITHUB_TOKEN ?? '');

    let event;
    try {
      event = githubAdapter.parseWebhook(request.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      logger.warn({ err: message }, `Failed to parse payload: ${message}`);
      return reply.status(400).send({ error: message });
    }

    // Step 5: Only process opened, synchronize, and reopened actions
    const validActions = ['opened', 'synchronize', 'reopened'];
    if (!validActions.includes(event.action)) {
      logger.info({ action: event.action }, `Ignoring PR action: ${event.action}`);
      return reply.status(200).send({ status: 'ignored', action: event.action });
    }

    // Step 6: Upsert DB records (Organization, Repository, PullRequest)
    const ownerName = event.repository.fullName.split('/')[0] || 'Unknown';
    const accountId = (request.body as { repository?: { owner?: { id: number } } })?.repository?.owner?.id;
    const orgId = accountId ? String(accountId) : ownerName;
    const installationId = (request.body as { installation?: { id: number } })?.installation?.id ? String((request.body as { installation?: { id: number } }).installation!.id) : undefined;
    
    // Ensure Org exists (Phase 3 readiness)
    const organization = await prisma.organization.upsert({
      where: { id: orgId },
      update: { name: ownerName, ...(installationId ? { githubInstallationId: installationId } : {}) },
      create: {
        id: orgId,
        name: ownerName,
        githubInstallationId: installationId
      },
    });

    try {
      const repository = await prisma.repository.upsert({
        where: { githubId: String(event.repository.id) },
        update: {
          cloneUrl: event.repository.cloneUrl,
          defaultBranch: event.repository.defaultBranch,
        },
        create: {
          githubId: String(event.repository.id),
          fullName: event.repository.fullName,
          cloneUrl: event.repository.cloneUrl,
          defaultBranch: event.repository.defaultBranch,
          organizationId: organization.id,
        },
      });

      await prisma.pullRequest.upsert({
        where: {
          repositoryId_prNumber: {
            repositoryId: repository.id,
            prNumber: event.pullRequest.number,
          },
        },
        update: {
          headSha: event.pullRequest.headSha,
          baseSha: event.pullRequest.baseSha,
          title: event.pullRequest.title,
          author: event.pullRequest.author,
          status: 'QUEUED',
        },
        create: {
          repositoryId: repository.id,
          prNumber: event.pullRequest.number,
          headSha: event.pullRequest.headSha,
          baseSha: event.pullRequest.baseSha,
          title: event.pullRequest.title,
          author: event.pullRequest.author,
          status: 'QUEUED',
        },
      });
    } catch (dbError) {
      logger.error({ dbError }, 'Failed to persist PR to DB');
      // Non-fatal, continue with enqueuing
    }

    // Enqueue the review job to BullMQ
    // Use headSha instead of Date.now() for BullMQ dedup to prevent duplicate reviews on GitHub retries
    const jobId = `review-${event.repository.id}-pr-${event.pullRequest.number}-${event.pullRequest.headSha}`;
    await queues.reviewQueue.add('review-pr', event, {
      jobId,
      removeOnComplete: true, // Auto-cleanup successful jobs
      removeOnFail: { count: 100 }, // Keep last 100 failures for debugging
    });

    logger.info(
      { jobId, repo: event.repository.fullName, prNum: event.pullRequest.number },
      `Enqueued review job: ${jobId} (${event.repository.fullName} PR #${event.pullRequest.number})`
    );

    // Step 7: Respond immediately — do NOT block on the review
    return reply.status(202).send({
      status: 'accepted',
      jobId,
      message: `Review queued for ${event.repository.fullName} PR #${event.pullRequest.number}`,
    });
  });
}
