#!/usr/bin/env node

/**
 * @module cli
 * CLI Entry Point — Orchestrates the full AI PR Review pipeline.
 *
 * This is the Phase 1 MVP: a command-line tool that reads a local git diff,
 * runs it through the deterministic intelligence pipeline, chunks it with
 * Tree-sitter, sends the chunks to an AI provider, and outputs structured
 * findings to the console.
 *
 * Usage:
 *   npx tsx src/cli.ts --diff <path-to-diff> --repo <path-to-repo>
 *
 * @see 13_IMPLEMENTATION_PLAN.md Phase 1 for the full task breakdown.
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Adapters
import { LocalDiffAdapter } from './adapters/local-diff.adapter.js';

// Intelligence Pipeline
import { detectTechnology } from './intelligence/technology-detector.js';
import { runRuleEngine } from './intelligence/rule-engine.js';
import { extractConventions } from './intelligence/convention-extractor.js';
import { buildReviewContext } from './intelligence/context-builder.js';

// Chunking
import { generateChunks } from './chunking/chunking-engine.js';

// AI Provider Factory
import { createAIProvider } from './ai/ai-provider.factory.js';

// Prompts
import { resolvePrompts } from './prompts/registry.js';

// Post-AI Pipeline
import { mergeAndRankFindings } from './pipeline/result-merger.js';
import { renderReviewOutput } from './pipeline/formatter.js';

// Types
import type { ChunkAnalysisResult, EnrichedFinding } from './types/index.js';



/**
 * Main CLI execution function.
 * Orchestrates the full review pipeline from diff to formatted output.
 *
 * Pipeline Steps:
 * 1. Parse the local diff file (GitPlatformAdapter)
 * 2. Detect the technology stack (Technology Detector)
 * 3. Run the deterministic Rule Engine
 * 4. Extract repository conventions
 * 5. Build the enriched ReviewContext
 * 6. Generate AST-based code chunks (Tree-sitter)
 * 7. Resolve the appropriate prompts (Prompt Registry)
 * 8. Run AI inference on each chunk
 * 9. Merge, deduplicate, and rank findings
 * 10. Render the output to the console
 *
 * @param diffPath - Path to the unified diff file.
 * @param repoPath - Path to the repository root.
 */
async function runReview(diffPath: string, repoPath: string): Promise<void> {
  const startTime = Date.now();

  console.log('🚀 Starting AI PR Review...\n');

  // ── Step 1: Parse the diff ─────────────────────────────────────────────
  console.log('📄 Parsing diff file...');
  const adapter = new LocalDiffAdapter(diffPath, repoPath);
  const event = adapter.parseWebhook(null);
  const diffFiles = await adapter.fetchDiff(event);
  console.log(`   Found ${diffFiles.length} changed file(s)\n`);

  if (diffFiles.length === 0) {
    console.log('⚠️  No changed files found in the diff. Exiting.');
    return;
  }

  // ── Step 2: Detect the technology stack ──────────────────────────────────
  console.log('🔍 Detecting technology stack...');
  const techProfile = detectTechnology(repoPath);
  const langSummary = techProfile.languages
    .slice(0, 5)
    .map((l) => `${l.name} (${l.percentage}%)`)
    .join(', ');
  console.log(`   Languages: ${langSummary || 'None detected'}`);
  console.log(`   Frameworks: ${techProfile.frameworks.join(', ') || 'None detected'}\n`);

  // ── Step 3: Run the deterministic Rule Engine ───────────────────────────
  console.log('🔧 Running Rule Engine...');
  const { findings: ruleFindings, reviewableFiles } = runRuleEngine(diffFiles);
  console.log(`   ${ruleFindings.length} rule finding(s), ${reviewableFiles.length} file(s) to review\n`);

  // Check for blocking findings (e.g., secrets detected)
  const blockingFindings = ruleFindings.filter((f) => f.blocking);
  if (blockingFindings.length > 0) {
    console.log('🚫 BLOCKING FINDINGS DETECTED — halting before AI inference:');
    for (const finding of blockingFindings) {
      console.log(`   [${finding.ruleId}] ${finding.message} (${finding.filePath})`);
    }
    renderReviewOutput([], ruleFindings, { provider: 'none', inputTokens: 0, outputTokens: 0, inferenceMs: 0, estimatedCostUsd: 0 }, 0);
    return;
  }

  if (reviewableFiles.length === 0) {
    console.log('⚠️  No reviewable files after Rule Engine filtering. Exiting.');
    renderReviewOutput([], ruleFindings, { provider: 'none', inputTokens: 0, outputTokens: 0, inferenceMs: 0, estimatedCostUsd: 0 }, 0);
    return;
  }

  // ── Step 4: Extract repository conventions ──────────────────────────────
  console.log('📖 Extracting repository conventions...');
  const conventions = await extractConventions(repoPath);
  console.log(`   ${conventions ? 'Guidelines found' : 'No guidelines found'}\n`);

  // ── Step 5: Build the enriched ReviewContext ────────────────────────────
  const context = buildReviewContext(event, techProfile, ruleFindings, conventions);

  // ── Step 6: Generate AST-based code chunks ──────────────────────────────
  console.log('🌳 Generating AST-based code chunks (Tree-sitter)...');
  const chunks = generateChunks(reviewableFiles, repoPath);
  console.log(`   Generated ${chunks.length} chunk(s)\n`);

  if (chunks.length === 0) {
    console.log('⚠️  No code chunks generated. Exiting.');
    renderReviewOutput([], ruleFindings, { provider: 'none', inputTokens: 0, outputTokens: 0, inferenceMs: 0, estimatedCostUsd: 0 }, 0);
    return;
  }

  // ── Step 7: Resolve prompts from the Prompt Registry ────────────────────
  console.log('📋 Resolving prompts from registry...');
  const prompts = resolvePrompts(techProfile);
  console.log(`   Loaded ${prompts.length} prompt(s): ${prompts.map((p) => p.name).join(', ')}\n`);

  // ── Step 8: Run AI inference ────────────────────────────────────────────
  console.log('🤖 Running AI inference...');
  const aiProvider = createAIProvider();
  console.log(`   Provider: ${aiProvider.name}`);
  console.log(`   Concurrency: ${aiProvider.getConcurrencyStrategy()}\n`);

  const allFindings: EnrichedFinding[] = [];
  const isParallel = aiProvider.getConcurrencyStrategy() === 'parallel';

  // Use the first prompt (primary review prompt)
  const primaryPrompt = prompts[0]!;

  if (isParallel) {
    // Cloud provider: fire all chunks concurrently
    const promises = chunks.map((chunk, idx) => {
      console.log(`   ⏳ Chunk ${idx + 1}/${chunks.length}: ${chunk.filePath} (${chunk.nodeType}: ${chunk.nodeName ?? 'anonymous'})`);
      return aiProvider.analyzeChunk(primaryPrompt, context, chunk).catch((err) => {
        console.warn(`   ⚠️  Chunk ${idx + 1} failed: ${err}`);
        return { findings: [] } as ChunkAnalysisResult;
      });
    });

    const results = await Promise.all(promises);
    for (const result of results) {
      allFindings.push(...result.findings);
    }
  } else {
    // Local provider: process sequentially to avoid VRAM exhaustion
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      console.log(`   ⏳ Chunk ${i + 1}/${chunks.length}: ${chunk.filePath} (${chunk.nodeType}: ${chunk.nodeName ?? 'anonymous'})`);
      try {
        const result = await aiProvider.analyzeChunk(primaryPrompt, context, chunk);
        allFindings.push(...result.findings);
      } catch (err) {
        console.warn(`   ⚠️  Chunk ${i + 1} failed: ${err}`);
      }
    }
  }

  console.log(`\n   ✅ AI analysis complete. ${allFindings.length} raw finding(s).\n`);

  // ── Step 9: Merge, deduplicate, and rank ────────────────────────────────
  const threshold = parseInt(process.env.MIN_CONFIDENCE_THRESHOLD ?? '85', 10);
  const mergedFindings = mergeAndRankFindings(allFindings, threshold);
  console.log(`📊 After dedup & ranking: ${mergedFindings.length} finding(s) (threshold: ${threshold}%)\n`);

  // ── Step 10: Render output ──────────────────────────────────────────────
  const metrics = aiProvider.getCostMetrics();
  renderReviewOutput(mergedFindings, ruleFindings, metrics, chunks.length);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️  Total review time: ${elapsed}s\n`);
}

// ── CLI Setup ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('ai-review')
  .description('AI PR Reviewer Bot — Staff Engineer-level automated code reviews')
  .version('0.1.0')
  .requiredOption('--diff <path>', 'Path to the unified diff file (.patch or git diff output)')
  .requiredOption('--repo <path>', 'Path to the repository root directory')
  .action(async (options: { diff: string; repo: string }) => {
    const diffPath = resolve(options.diff);
    const repoPath = resolve(options.repo);

    // Validate inputs
    if (!existsSync(diffPath)) {
      console.error(`❌ Diff file not found: ${diffPath}`);
      process.exit(1);
    }
    if (!existsSync(repoPath)) {
      console.error(`❌ Repository path not found: ${repoPath}`);
      process.exit(1);
    }

    try {
      await runReview(diffPath, repoPath);
    } catch (error) {
      console.error('❌ Review failed:', error);
      process.exit(1);
    }
  });

program.parse();
