/**
 * @module api/routes
 * Dashboard API Routes for Fastify.
 *
 * Provides REST endpoints for the Next.js frontend to fetch telemetry,
 * repository lists, and review findings.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { verifyAuth } from './middleware/auth.js';
import { execSync } from 'node:child_process';
import { runRuleEngine } from '../intelligence/rule-engine.js';
import { parseGitDiff } from '../adapters/github.adapter.js';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { Queues } from '../queue/queue-config.js';
import type { PullRequestEvent } from '../types/index.js';
import { getLogger } from '../utils/logger.js';
import { RepositoryCache } from '../cache/repository-cache.js';

const logger = getLogger('api-routes');

/**
 * Registers all dashboard API routes on the Fastify instance.
 */
export function registerDashboardRoutes(app: FastifyInstance, queues?: Queues): void {
  // ── Authentication ───────────────────────────────────────────────────
  app.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, password } = request.body as { email?: string; password?: string };
    
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !(await bcrypt.compare(password, user.hashedPassword))) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    return reply.status(200).send({ 
      id: user.id, 
      email: user.email, 
      role: user.role,
      organizationId: user.organizationId 
    });
  });

  // ── Protected Routes ─────────────────────────────────────────────────
  
  // High-level stats for the dashboard overview
  app.get('/api/v1/dashboard/stats', { preHandler: verifyAuth }, async (request, reply) => {
    const { organizationId } = request.user!;

    const reposCount = await prisma.repository.count({ where: { organizationId } });
    const prsCount = await prisma.pullRequest.count({ 
      where: { repository: { organizationId } } 
    });
    const findingsCount = await prisma.reviewFinding.count({
      where: { pullRequest: { repository: { organizationId } } }
    });

    // Sum up total costs from telemetry
    const telemetry = await prisma.telemetry.aggregate({
      where: { pullRequest: { repository: { organizationId } } },
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true }
    });

    const severityGroups = await prisma.reviewFinding.groupBy({
      by: ['severity'],
      where: { pullRequest: { repository: { organizationId } } },
      _count: { _all: true }
    });

    const severityData = [
      { name: "Critical", value: severityGroups.find(g => g.severity === 'Critical')?._count._all || 0 },
      { name: "High", value: severityGroups.find(g => g.severity === 'High')?._count._all || 0 },
      { name: "Medium", value: severityGroups.find(g => g.severity === 'Medium')?._count._all || 0 },
      { name: "Low", value: severityGroups.find(g => g.severity === 'Low')?._count._all || 0 },
    ];

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6); // Last 7 days including today
    sevenDaysAgo.setHours(0, 0, 0, 0);
    
    const recentTelemetry = await prisma.telemetry.findMany({
      where: { 
        pullRequest: { repository: { organizationId } },
        createdAt: { gte: sevenDaysAgo }
      },
      select: { estimatedCostUsd: true, createdAt: true }
    });

    const costDataMap = new Map();
    // Initialize last 7 days with 0
    for(let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' }); // e.g. "Mon"
      costDataMap.set(dayName, 0);
    }
    
    recentTelemetry.forEach(t => {
      const dayName = t.createdAt.toLocaleDateString('en-US', { weekday: 'short' });
      if (costDataMap.has(dayName)) {
        costDataMap.set(dayName, costDataMap.get(dayName) + t.estimatedCostUsd);
      }
    });
    
    const costData = Array.from(costDataMap.entries()).map(([name, cost]) => ({ 
      name, 
      cost: Number(cost.toFixed(4)) 
    }));

    return reply.status(200).send({
      totalRepositories: reposCount,
      totalPullRequests: prsCount,
      totalFindings: findingsCount,
      totalCostUsd: telemetry._sum.estimatedCostUsd || 0,
      totalInputTokens: telemetry._sum.inputTokens || 0,
      totalOutputTokens: telemetry._sum.outputTokens || 0,
      severityData,
      costData
    });
  });

  // List all repositories
  app.get('/api/v1/repos', { preHandler: verifyAuth }, async (request, reply) => {
    const { organizationId } = request.user!;
    
    const repos = await prisma.repository.findMany({
      where: { organizationId },
      include: {
        _count: { select: { pullRequests: true } }
      },
      orderBy: { updatedAt: 'desc' }
    });
    
    return reply.status(200).send(repos);
  });

  // List PRs and Telemetry for a specific repository
  app.get('/api/v1/repos/:id/prs', { preHandler: verifyAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { organizationId } = request.user!;

    // Ensure user has access to this repo
    const repo = await prisma.repository.findFirst({
      where: { id, organizationId }
    });

    if (!repo) {
      return reply.status(404).send({ error: 'Repository not found or access denied' });
    }

    const prs = await prisma.pullRequest.findMany({
      where: { repositoryId: repo.id },
      include: {
        telemetry: true,
        _count: { select: { findings: true } }
      },
      orderBy: { updatedAt: 'desc' }
    });

    return reply.status(200).send({ repository: repo, pullRequests: prs });
  });

  // Delete a specific repository
  app.delete('/api/v1/repos/:id', { preHandler: verifyAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { organizationId } = request.user!;

    // Check ownership
    const repo = await prisma.repository.findFirst({
      where: { id, organizationId }
    });

    if (!repo) {
      return reply.status(404).send({ error: 'Repository not found or access denied' });
    }

    await prisma.repository.delete({ where: { id } });
    return reply.status(200).send({ success: true, message: 'Repository deleted successfully' });
  });

  // Delete repository cache completely
  app.delete('/api/v1/cache/repos/:id', { preHandler: verifyAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { organizationId } = request.user!;

    const repo = await prisma.repository.findFirst({
      where: { id, organizationId }
    });

    if (!repo) {
      return reply.status(404).send({ error: 'Repository not found or access denied' });
    }

    const repoCache = new RepositoryCache();
    // In review-worker, the cache folder uses fullName with '/' replaced by '-'
    const cacheId = repo.fullName.replace('/', '-');
    const deleted = await repoCache.deleteRepository(cacheId);

    return reply.status(200).send({ 
      success: true, 
      deleted, 
      message: deleted ? 'Cache deleted successfully' : 'Cache folder not found' 
    });
  });

  // View specific findings for a PR
  app.get('/api/v1/prs/:id/findings', { preHandler: verifyAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { organizationId } = request.user!;

    const pr = await prisma.pullRequest.findFirst({
      where: { id, repository: { organizationId } },
      include: {
        findings: { orderBy: [{ severity: 'asc' }, { confidence: 'desc' }] }
      }
    });

    if (!pr) {
      return reply.status(404).send({ error: 'Pull Request not found or access denied' });
    }

    return reply.status(200).send(pr);
  });

  // ── VS Code Extension: Manual Review Trigger ────────────────────────

  app.post('/api/v1/reviews/manual', async (request: FastifyRequest<{ Body: { path: string } }>, reply) => {
    try {
      const workspacePath = request.body.path;
      if (!workspacePath) {
        return reply.status(400).send({ error: 'Missing path in request body' });
      }

      // Execute local git diff
      const diffOutput = execSync('git diff HEAD', { cwd: workspacePath, encoding: 'utf8' });
      
      if (!diffOutput.trim()) {
        return reply.send({ findings: [] });
      }

      // Parse diff using existing adapter logic (we exported parseGitDiff in github.adapter previously)
      const diffFiles = parseGitDiff(diffOutput);

      // Run deterministic rule engine
      const { findings: ruleFindings } = runRuleEngine(diffFiles);

      // For MVP of VS Code extension, we just return the deterministic findings
      // (Full AI integration would require awaiting the AI Provider here)
      const findings = ruleFindings.map((f: { ruleId: string; blocking?: boolean; message: string; filePath: string; lineNumber?: number }) => ({
        title: `[${f.ruleId}] Security Warning`,
        severity: f.blocking ? 'Critical' : 'Medium',
        confidence: '100%',
        evidence: f.message,
        recommendation: 'Please fix this issue locally.',
        file: f.filePath,
        line: f.lineNumber ?? 0
      }));

      return reply.send({ findings });
    } catch (error: unknown) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ── Dashboard Manual Trigger ─────────────────────────────────────────

  app.post('/api/v1/dashboard/trigger', { preHandler: verifyAuth }, async (request, reply) => {
    try {
      const { url } = request.body as { url?: string };
      logger.info({ url }, 'Triggering manual review');
      
      if (!url || !url.includes('github.com')) {
        return reply.status(400).send({ error: 'Valid GitHub PR URL is required' });
      }

      const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!match) {
        return reply.status(400).send({ error: 'Invalid GitHub PR URL format' });
      }

      const [, owner, repo, prNumberStr] = match;
      const prNumber = parseInt(prNumberStr, 10);

      const organizationId = request.user!.organizationId;
      const org = await prisma.organization.findUnique({ where: { id: organizationId } });

      let octokit: Octokit;
      if (org?.githubInstallationId && process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
        octokit = new Octokit({
          authStrategy: createAppAuth,
          auth: {
            appId: process.env.GITHUB_APP_ID,
            privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
            installationId: org.githubInstallationId,
          }
        });
      } else {
        const token = process.env.GITHUB_TOKEN !== 'ghp_your_github_token_here' ? process.env.GITHUB_TOKEN : undefined;
        octokit = new Octokit({ auth: token });
      }

      let pr, repository;
      try {
        logger.info({ owner, repo, prNumber }, 'Fetching PR details from GitHub API');
        const [prResponse, repoResponse] = await Promise.all([
          octokit.pulls.get({ owner, repo, pull_number: prNumber }),
          octokit.repos.get({ owner, repo })
        ]);
        pr = prResponse.data;
        repository = repoResponse.data;
      } catch (octoErr: unknown) {
        const status = typeof octoErr === 'object' && octoErr !== null && 'status' in octoErr ? (octoErr as { status: number }).status : undefined;
        if (status === 404) {
          return reply.status(404).send({ error: 'Pull Request not found. Please ensure the repository is public and the PR exists, or provide a valid GitHub Token in .env for private repositories.' });
        }
        if (status === 403 || status === 401) {
          return reply.status(403).send({ error: 'GitHub API limit exceeded or unauthorized. Please configure a valid GITHUB_TOKEN in your .env file.' });
        }
        throw octoErr;
      }
      logger.info({ title: pr.title }, `Fetched PR: "${pr.title}"`);

      logger.info('Upserting repo and PR in database');
      // Ensure repo exists in this organization
      const dbRepo = await prisma.repository.upsert({
        where: { githubId: String(repository.id) },
        update: {
          cloneUrl: repository.clone_url,
          defaultBranch: repository.default_branch,
          organizationId
        },
        create: {
          githubId: String(repository.id),
          fullName: repository.full_name,
          cloneUrl: repository.clone_url,
          defaultBranch: repository.default_branch,
          organizationId
        },
      });

      await prisma.pullRequest.upsert({
        where: {
          repositoryId_prNumber: { repositoryId: dbRepo.id, prNumber: pr.number },
        },
        update: {
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          title: pr.title,
          author: pr.user?.login || 'unknown',
          status: 'QUEUED',
        },
        create: {
          repositoryId: dbRepo.id,
          prNumber: pr.number,
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          title: pr.title,
          author: pr.user?.login || 'unknown',
          status: 'QUEUED',
        },
      });
      logger.info('DB upsert complete');

      if (!queues) {
        logger.error('Queues not initialized');
        return reply.status(500).send({ error: 'Queues not initialized' });
      }

      const event: PullRequestEvent = {
        platform: 'github',
        repository: {
          id: String(repository.id),
          fullName: repository.full_name,
          cloneUrl: repository.clone_url,
          defaultBranch: repository.default_branch,
        },
        pullRequest: {
          number: pr.number,
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          title: pr.title,
          description: pr.body || '',
          author: pr.user?.login || 'unknown',
        },
        action: 'opened',
      };

      const jobId = `manual-review-${repository.id}-pr-${pr.number}-${Date.now()}`;
      logger.info({ jobId }, `Adding to review queue: ${jobId}`);
      await queues.reviewQueue.add('pr-review', { event, state: 'QUEUED', timestamp: Date.now() }, { jobId });
      logger.info({ jobId }, 'Review enqueued successfully');

      return reply.send({ success: true, jobId, message: 'Review enqueued successfully' });
    } catch (error: unknown) {
      logger.error({ err: error }, 'Dashboard trigger error');
      return reply.status(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
