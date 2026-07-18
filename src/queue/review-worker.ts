/**
 * @module queue/review-worker
 * Review Worker — The core Review State Machine executor.
 *
 * Processes the full review pipeline as a BullMQ worker:
 * QUEUED → Repository Ready → Repository Indexed → Context Generated
 * → AI Reviewing → Results Validated → Publishing → Completed
 *
 * This single worker orchestrates the entire lifecycle of a PR review,
 * dispatching AI chunk jobs in parallel and collecting results.
 *
 * @see 04_REVIEW_STATE_MACHINE.md for state transitions.
 */

import { Worker, type Job } from 'bullmq';
import { QUEUE_NAMES, getRedisConnection, type Queues } from './queue-config.js';

// Adapters
import { createGitHubAdapter, parseGitDiff } from '../adapters/github.adapter.js';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { execSync } from 'node:child_process';

// Intelligence Pipeline
import { detectTechnology } from '../intelligence/technology-detector.js';
import { runRuleEngine } from '../intelligence/rule-engine.js';
import { extractConventions } from '../intelligence/convention-extractor.js';
import { buildReviewContext } from '../intelligence/context-builder.js';
import { calculateBlastRadius } from '../intelligence/module-grapher.js';

// Chunking
import { generateChunks } from '../chunking/chunking-engine.js';

// AI
import type { AIProvider } from '../ai/ai-provider.interface.js';

// Prompts
import { resolvePrompts, loadTemplate } from '../prompts/registry.js';

// Post-AI Pipeline
import { mergeAndRankFindings } from '../pipeline/result-merger.js';
import { calculateReviewScore } from '../ai/score-calculator.js';

// Cache
import { createRepositoryCache } from '../cache/repository-cache.js';

// Database
import { prisma } from '../db/prisma.js';

// Logger
import { getLogger } from '../utils/logger.js';

// Metrics
import { prReviewsTotal, aiTokensTotal, aiInferenceDuration, aiCostUsdTotal, findingsTotal } from '../api/metrics.js';

// Types
import type { ChunkAnalysisResult, PullRequestEvent, EnrichedFinding, CodeChunk } from '../types/index.js';

const logger = getLogger('review-worker');

/** Review state labels for logging and tracking */
type ReviewState =
  | 'RECEIVED'
  | 'QUEUED'
  | 'REPOSITORY_READY'
  | 'REPOSITORY_INDEXED'
  | 'CONTEXT_GENERATED'
  | 'AI_REVIEWING'
  | 'RESULTS_VALIDATED'
  | 'PUBLISHING'
  | 'COMPLETED'
  | 'FAILED';

/**
 * The data payload passed through the review job.
 */
interface ReviewJobData {
  event: PullRequestEvent;
  state: ReviewState;
  timestamp: number;
}

/**
 * Logs a state transition for observability and persists it to the database.
 *
 * @param event - The PR event object containing repository and PR info.
 * @param from - The previous state.
 * @param to - The new state.
 */
async function logStateTransition(event: PullRequestEvent, from: ReviewState, to: ReviewState, errorMessage?: string): Promise<void> {
  logger.info({ prNumber: event.pullRequest.number, from, to }, `PR #${event.pullRequest.number}: ${from} → ${to}`);

  try {
    const repositoryId = String(event.repository.id); // githubId
    const repo = await prisma.repository.findUnique({
      where: { githubId: repositoryId },
    });
    
    if (repo) {
      const dataToUpdate: any = { status: to };
      if (errorMessage) {
        dataToUpdate.errorMessage = errorMessage;
      }
      
      await prisma.pullRequest.update({
        where: {
          repositoryId_prNumber: {
            repositoryId: repo.id,
            prNumber: event.pullRequest.number,
          },
        },
        data: dataToUpdate,
      });
    }
  } catch (err) {
    logger.warn({ err, prNumber: event.pullRequest.number }, `Failed to sync state to DB for PR #${event.pullRequest.number}`);
  }
}

/**
 * Creates and starts the Review Worker.
 *
 * The worker listens on the REVIEW queue and executes the full
 * review pipeline for each PR event. It:
 * 1. Clones/fetches the repository via the cache
 * 2. Runs the deterministic intelligence pipeline
 * 3. Generates AST-based code chunks
 * 4. Sends chunks to the AI provider (parallel or sequential)
 * 5. Merges and ranks the findings
 * 6. Posts the review back to GitHub
 *
 * @param aiProvider - The configured AI provider instance.
 * @param queues - The BullMQ queue instances.
 * @returns The started Worker instance.
 */
export function createReviewWorker(
  aiProvider: AIProvider,
  queues: Queues
): Worker {
  const connection = getRedisConnection();
  const repoCache = createRepositoryCache();

  const worker = new Worker<ReviewJobData>(
    QUEUE_NAMES.REVIEW,
    async (job: Job<ReviewJobData>) => {
      const { event } = job.data;
      const prNum = event.pullRequest.number;
      let currentState: ReviewState = 'QUEUED';

      try {
        // ── State: REPOSITORY_READY ───────────────────────────────────
        await logStateTransition(event, currentState, 'REPOSITORY_READY');
        currentState = 'REPOSITORY_READY';
        await job.updateProgress(10);

        // Fetch the repository to get the organization and installationId
        const repo = await prisma.repository.findUnique({
          where: { githubId: String(event.repository.id) },
          include: { organization: true }
        });

        // Initialize GitHub adapter with App or PAT
        let githubAdapter: ReturnType<typeof createGitHubAdapter>;
        const org = repo?.organization;
        
        if (org?.githubInstallationId && process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
          githubAdapter = createGitHubAdapter({
            appId: process.env.GITHUB_APP_ID,
            privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
            installationId: org.githubInstallationId,
          });
        } else {
          githubAdapter = createGitHubAdapter(process.env.GITHUB_TOKEN ?? '');
        }

        // Build the clone URL with authentication token
        const cloneUrl = await githubAdapter.getCloneUrl(event.repository.cloneUrl);

        // Ensure the repo is cached and create a worktree
        const bareRepoPath = await repoCache.ensureRepository(
          event.repository.fullName.replace('/', '-'),
          cloneUrl
        );
        const worktreePath = await repoCache.createWorktree(
          bareRepoPath,
          event.pullRequest.headSha,
          prNum
        );

        const initialMetrics = aiProvider.getCostMetrics();

        try {
          // ── State: REPOSITORY_INDEXED ─────────────────────────────────
          await logStateTransition(event, currentState, 'REPOSITORY_INDEXED');
          currentState = 'REPOSITORY_INDEXED';
          await job.updateProgress(20);

          // Fetch the diff (Local fallback for E2E testing or API limits)
          let diffFiles;
          const isLocalTest = event.repository.cloneUrl.startsWith('file://');

          try {
            if (isLocalTest) {
              throw new Error("Force local");
            }
            diffFiles = await githubAdapter.fetchDiff(event);
            if (!diffFiles || diffFiles.length === 0) {
              throw new Error('Diff is empty or unavailable. Cannot proceed with review.');
            }
          } catch (fetchErr) {
            logger.warn({ prNum, err: fetchErr }, `PR #${prNum}: GitHub API diff fetch failed, falling back to local git diff`);
            const diffOutput = execSync(`git diff ${event.pullRequest.baseSha} ${event.pullRequest.headSha}`, { cwd: bareRepoPath, encoding: 'utf8' });
            diffFiles = parseGitDiff(diffOutput);
            if (!diffFiles || diffFiles.length === 0) {
              throw new Error('Local fallback diff is also empty or unavailable. Cannot proceed with review.');
            }
          }

          // Run the deterministic intelligence pipeline
          const techProfile = detectTechnology(worktreePath);
          const { findings: ruleFindings, reviewableFiles } = runRuleEngine(diffFiles, worktreePath);

          logger.info(
            { prNum, diffFiles: diffFiles.length, ruleFindings: ruleFindings.length, reviewableFiles: reviewableFiles.length },
            `PR #${prNum}: ${diffFiles.length} files, ${ruleFindings.length} rule findings, ${reviewableFiles.length} reviewable`
          );

          // Check for blocking findings
          const hasBlockingFindings = ruleFindings.some((f) => f.blocking);
          if (hasBlockingFindings) {
            logger.info({ prNum }, `PR #${prNum}: Blocking findings detected — skipping AI`);

            const blockingEnriched = ruleFindings.filter(f => f.blocking).map(f => ({
              ...f,
              severity: f.severity.charAt(0).toUpperCase() + f.severity.slice(1) as any,
              lineNumber: f.lineNumber || 1,
              confidence: 100,
              impact: 'Automated policy violation prevents further code review.',
              recommendation: f.message,
              title: `Blocking Rule: ${f.message}`,
              evidence: `Violated repository rule: ${f.ruleId}`,
              sourceChunkId: 'rule-engine',
            } as EnrichedFinding));

            if (!isLocalTest) {
              await githubAdapter.postReview(event, blockingEnriched, { summary: 'Blocking rules violated. Code review halted.', risk: 'Critical' });
            } else {
              logger.info(`[Local Test] Mocked posting blocking review.`);
            }
            await logStateTransition(event, currentState, 'COMPLETED');
            return;
          }

          if (reviewableFiles.length === 0) {
            logger.info({ prNum }, `PR #${prNum}: No reviewable files detected. Continuing pipeline to generate PR summary.`);
          }

          // ── State: CONTEXT_GENERATED ──────────────────────────────────
          await logStateTransition(event, currentState, 'CONTEXT_GENERATED');
          currentState = 'CONTEXT_GENERATED';
          await job.updateProgress(40);

          const conventions = await extractConventions(worktreePath, repo?.id);
          const modifiedFilesList = diffFiles.map(f => f.filePath);
          const blastRadius = await calculateBlastRadius(worktreePath, modifiedFilesList);
          
          const context = buildReviewContext(event, techProfile, ruleFindings, conventions, blastRadius);

          // ── State: AI_REVIEWING ───────────────────────────────────────
          await logStateTransition(event, currentState, 'AI_REVIEWING');
          currentState = 'AI_REVIEWING';
          await job.updateProgress(50);

          const diffContextFull = diffFiles.map(df => 
            `File: ${df.filePath}\n${df.hunks.map(h => h.content).join('\n')}`
          ).join('\n\n');
          logger.debug({ prNum, diffContextLength: diffContextFull.length }, 'Generated raw diff context (omitted from logs due to size)');

          // Generate AST-based chunks
          const chunks = generateChunks(reviewableFiles, worktreePath);
          logger.info({ prNum, chunksCount: chunks.length }, `PR #${prNum}: Generated ${chunks.length} chunks for AI analysis`);

          if (chunks.length === 0) {
            logger.info({ prNum }, `PR #${prNum}: No chunks generated. Creating a fallback chunk to generate PR summary.`);
            chunks.push({
              chunkId: 'pr-summary-fallback',
              filePath: 'MULTIPLE_FILES',
              nodeType: 'block',
              nodeName: null,
              startLine: 1,
              endLine: 1,
              content: 'Please summarize the overall pull request based on the diff context provided. No specific code findings are expected unless there are obvious critical issues in the provided diff.',
              surroundingContext: diffContextFull.substring(0, 40000),
              changedLines: [],
            });
          }

          // Resolve prompts based on tech stack
          const prompts = resolvePrompts(techProfile);

          // Execute AI inference (parallel for cloud, sequential for local)
          const allFindings: EnrichedFinding[] = [];
          const isParallel = aiProvider.getConcurrencyStrategy() === 'parallel';

          // Collect PR-level metadata from chunk results (first non-empty wins)
          let prSummary: string | undefined;
          let prRisk: string | undefined;
          let prSuggestedTests: string[] = [];

          if (isParallel) {
            const limit = pLimit(5);
            const promises = chunks.flatMap((chunk) =>
              prompts.map((prompt) =>
                limit(() => aiProvider
                  .analyzeChunk(prompt, context, chunk)
                  .catch((err) => {
                    logger.warn({ prNum, chunkId: chunk.chunkId, prompt: prompt.name, err }, `PR #${prNum}: Chunk ${chunk.chunkId} with prompt ${prompt.name} failed`);
                    return { findings: [] } as ChunkAnalysisResult;
                  }))
              )
            );
            const results = await Promise.all(promises);
            for (const result of results) {
              allFindings.push(...result.findings);
              if (!prSummary && result.summary) prSummary = result.summary;
              if (!prRisk && result.risk) prRisk = result.risk;
              if (result.suggestedTests?.length) prSuggestedTests.push(...result.suggestedTests);
            }
          } else {
            for (const chunk of chunks) {
              for (const prompt of prompts) {
                try {
                  const result = await aiProvider.analyzeChunk(prompt, context, chunk);
                  allFindings.push(...result.findings);
                  if (!prSummary && result.summary) prSummary = result.summary;
                  if (!prRisk && result.risk) prRisk = result.risk;
                  if (result.suggestedTests?.length) prSuggestedTests.push(...result.suggestedTests);
                } catch (err) {
                  logger.warn({ prNum, chunkId: chunk.chunkId, prompt: prompt.name, err }, `PR #${prNum}: Chunk ${chunk.chunkId} with prompt ${prompt.name} failed`);
                }
              }
            }
          }

          // Deduplicate suggested tests
          prSuggestedTests = [...new Set(prSuggestedTests)];

          if (chunks.length > 0 && allFindings.length === 0 && !prSummary) {
            throw new Error('All AI chunk analysis attempts failed. Aborting review to prevent false-positive 10/10 score.');
          }

          await job.updateProgress(80);

          // ── State: RESULTS_VALIDATED ───────────────────────────────────
          await logStateTransition(event, currentState, 'RESULTS_VALIDATED');
          currentState = 'RESULTS_VALIDATED';

          const threshold = parseInt(process.env.MIN_CONFIDENCE_THRESHOLD ?? '70', 10);
          let mergedFindings = mergeAndRankFindings(allFindings, threshold);

          logger.info(
            { prNum, rawFindings: allFindings.length, mergedFindings: mergedFindings.length, summary: prSummary, risk: prRisk },
            `PR #${prNum}: ${allFindings.length} raw findings → ${mergedFindings.length} after merge | Risk: ${prRisk || 'N/A'}`
          );

          // R3 VERIFICATION PASS
          const verificationPrompt = loadTemplate('verification');
          if (verificationPrompt && mergedFindings.length > 0) {
            logger.info({ prNum }, `PR #${prNum}: Running R3 Verification Pass on ${mergedFindings.length} findings`);
            
            // Build diff string for context
            const diffContext = diffFiles.map(df => 
              `File: ${df.filePath}\n${df.hunks.map(h => h.content).join('\n')}`
            ).join('\n\n');

            const verificationChunk: CodeChunk = {
              chunkId: 'verification-r3',
              filePath: 'ALL_FILES',
              nodeType: 'block',
              nodeName: null,
              startLine: 1,
              endLine: 1,
              content: JSON.stringify(mergedFindings, null, 2),
              surroundingContext: diffContext.substring(0, 40000),
              changedLines: [],
            };

            try {
              const verificationResult = await aiProvider.analyzeChunk(verificationPrompt, context, verificationChunk);
              
              // Restore original filePath and lineNumber from the original findings
              const verifiedEnriched: EnrichedFinding[] = [];
              for (const vf of verificationResult.findings) {
                // Match by title
                const original = mergedFindings.find(mf => mf.title === vf.title);
                if (original) {
                   verifiedEnriched.push({
                     ...vf,
                     filePath: original.filePath,
                     lineNumber: original.lineNumber,
                     sourceChunkId: original.sourceChunkId,
                   });
                } else {
                   logger.warn({ prNum, findingTitle: vf.title }, 'R3 Verification produced a finding not in original list. Dropping hallucination.');
                }
              }
              mergedFindings = verifiedEnriched;
              logger.info({ prNum, verifiedFindings: mergedFindings.length }, `PR #${prNum}: R3 Verification completed. Kept ${mergedFindings.length} findings.`);
            } catch (err) {
              logger.warn({ prNum, err }, `PR #${prNum}: R3 Verification failed, falling back to unverified findings.`);
            }
          }

          // Append non-blocking rule engine findings so they are always reported
          const nonBlockingEnriched = ruleFindings.filter(f => !f.blocking).map(f => ({
            title: `Automated Rule: ${f.ruleId}`,
            severity: f.severity.charAt(0).toUpperCase() + f.severity.slice(1) as any,
            confidence: 100,
            impact: 'Repository policy or automated check flagged this change.',
            evidence: f.message,
            recommendation: 'Please review the flagged change to ensure it aligns with project guidelines.',
            issueCode: '',
            suggestedFix: '',
            filePath: f.filePath,
            lineNumber: f.lineNumber || 1,
            sourceChunkId: 'rule-engine',
            references: [],
          } as EnrichedFinding));

          mergedFindings.push(...nonBlockingEnriched);

          // Re-sort mergedFindings
          const severityRank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
          mergedFindings.sort((a, b) => (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99) || b.confidence - a.confidence);

          // CALCULATE SCORE
          const prScore = calculateReviewScore(mergedFindings);
          logger.info({ prNum, score: prScore.score, interpretation: prScore.interpretation }, `PR #${prNum}: Calculated Score ${prScore.score}/10`);
          
          if (prSummary) {
             prSummary = `**Review Score:** ${prScore.score}/10 (${prScore.interpretation})\n\n${prSummary}`;
          } else {
             prSummary = `**Review Score:** ${prScore.score}/10 (${prScore.interpretation})`;
          }

          // ── State: PUBLISHING ─────────────────────────────────────────
          await logStateTransition(event, currentState, 'PUBLISHING');
          currentState = 'PUBLISHING';
          await job.updateProgress(90);

          const hasValidToken = githubAdapter.hasAuth();
          const shouldPostToGithub = process.env.POST_REVIEW_TO_GITHUB === 'true';
          
          if (!isLocalTest && hasValidToken && shouldPostToGithub) {
            try {
              await githubAdapter.postReview(event, mergedFindings, {
                summary: prSummary,
                risk: prRisk,
                suggestedTests: prSuggestedTests,
              });
            } catch (postErr) {
              logger.warn({ prNum, err: postErr }, `PR #${prNum}: Failed to post review to GitHub, but findings were generated successfully.`);
            }
          } else {
            logger.info(`[Local Test / Posting Disabled] Skipped posting review to GitHub.`);
          }

          // ── State: COMPLETED ──────────────────────────────────────────
          await logStateTransition(event, currentState, 'COMPLETED');
          currentState = 'COMPLETED';
          await job.updateProgress(100);

          const finalMetrics = aiProvider.getCostMetrics();
          
          const usedInputTokens = finalMetrics.inputTokens - initialMetrics.inputTokens;
          const usedOutputTokens = finalMetrics.outputTokens - initialMetrics.outputTokens;
          const usedCostUsd = finalMetrics.estimatedCostUsd - initialMetrics.estimatedCostUsd;
          const usedInferenceMs = finalMetrics.inferenceMs - initialMetrics.inferenceMs;
          
          // Persist Findings, Telemetry, and PR Metadata to Database
          try {
            const repo = await prisma.repository.findUnique({
              where: { githubId: String(event.repository.id) }
            });
            if (repo) {
              const pr = await prisma.pullRequest.findUnique({
                where: { repositoryId_prNumber: { repositoryId: repo.id, prNumber: prNum } }
              });
              if (pr) {
                // Save PR-level metadata (summary, risk, suggestedTests)
                await prisma.pullRequest.update({
                  where: { id: pr.id },
                  data: {
                    summary: prSummary || null,
                    riskLevel: prRisk || null,
                    suggestedTests: prSuggestedTests.length > 0 ? JSON.stringify(prSuggestedTests) : null,
                  },
                });

                // Save telemetry
                await prisma.telemetry.upsert({
                  where: { pullRequestId: pr.id },
                  update: {
                    provider: finalMetrics.provider,
                    inputTokens: usedInputTokens,
                    outputTokens: usedOutputTokens,
                    inferenceMs: usedInferenceMs,
                    estimatedCostUsd: usedCostUsd,
                  },
                  create: {
                    pullRequestId: pr.id,
                    provider: finalMetrics.provider,
                    inputTokens: usedInputTokens,
                    outputTokens: usedOutputTokens,
                    inferenceMs: usedInferenceMs,
                    estimatedCostUsd: usedCostUsd,
                  },
                });

                // Save findings (delete existing for this PR and re-insert)
                await prisma.reviewFinding.deleteMany({
                  where: { pullRequestId: pr.id }
                });
                
                if (mergedFindings.length > 0) {
                  await prisma.reviewFinding.createMany({
                    data: mergedFindings.map(f => ({
                      pullRequestId: pr.id,
                      filePath: f.filePath,
                      lineNumber: f.lineNumber,
                      severity: f.severity as 'Critical' | 'High' | 'Medium' | 'Low',
                      title: f.title,
                      evidence: f.evidence,
                      recommendation: f.recommendation,
                      issueCode: f.issueCode,
                      suggestedFix: f.suggestedFix,
                      confidence: f.confidence,
                      ruleId: null,
                    }))
                  });
                  findingsTotal.inc({ status: 'PENDING' }, mergedFindings.length);
                }
              }
            }
          } catch (dbErr) {
            logger.error({ prNum, dbErr }, `PR #${prNum}: Failed to persist findings/telemetry`);
          }

          logger.info(
            { prNum, findingsPosted: mergedFindings.length, cost: usedCostUsd },
            `PR #${prNum}: Review complete. ${mergedFindings.length} findings posted. Cost: $${usedCostUsd.toFixed(5)}`
          );

          // RECORD PROMETHEUS METRICS
          prReviewsTotal.inc({ status: 'completed' });
          aiTokensTotal.inc({ provider: finalMetrics.provider, type: 'input' }, usedInputTokens);
          aiTokensTotal.inc({ provider: finalMetrics.provider, type: 'output' }, usedOutputTokens);
          aiCostUsdTotal.inc({ provider: finalMetrics.provider }, usedCostUsd);
          aiInferenceDuration.observe({ provider: finalMetrics.provider, model: process.env.AI_MODEL || 'unknown' }, usedInferenceMs / 1000);
        } finally {
          // ── Always cleanup the worktree ──────────────────────────────
          await repoCache.removeWorktree(bareRepoPath, worktreePath);
        }
      } catch (error: any) {
        const attempt = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts || 1;
        
        // Categorize error
        const rawMsg = error?.message || String(error);
        let errorMsg = `Analysis Error: ${rawMsg}`;
        if (rawMsg.includes('429')) {
          errorMsg = 'API Rate Limit Exceeded (429 Too Many Requests). Please wait and try again.';
        } else if (rawMsg.includes('length') || rawMsg.includes('too large') || rawMsg.includes('tokens')) {
          errorMsg = 'The code chunk is too large for the AI context window. Please split the PR into smaller changes.';
        }

        if (attempt < maxAttempts) {
          const retryMsg = `${errorMsg} (Retrying... Attempt ${attempt + 1} of ${maxAttempts})`;
          await logStateTransition(event, currentState, currentState, retryMsg);
          logger.warn({ prNum, currentState, error: rawMsg }, `PR #${prNum}: Review interrupted. Retrying attempt ${attempt + 1}/${maxAttempts}`);
        } else {
          await logStateTransition(event, currentState, 'FAILED', errorMsg);
          logger.error({ prNum, currentState, error: rawMsg }, `PR #${prNum}: Review FAILED at state ${currentState}`);
          prReviewsTotal.inc({ status: 'failed' });
        }
        
        throw error; // Re-throw to trigger BullMQ retry
      }
    },
    {
      connection,
      concurrency: 3, // Process up to 3 PRs concurrently
      lockDuration: 5 * 60 * 1000, // 5 minutes lock duration for long-running AI inferences
      maxStalledCount: 5, // Allow up to 5 stall retries
      stalledInterval: 5 * 60 * 1000, // Check for stalled jobs every 5 minutes
      limiter: {
        max: 10,
        duration: 60_000, // Max 10 reviews per minute
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, prNum: job.data.event.pullRequest.number }, `Job ${job.id} completed for PR #${job.data.event.pullRequest.number}`);
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, `Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
