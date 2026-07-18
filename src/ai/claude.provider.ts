/**
 * @module ai/claude.provider
 * Anthropic Claude AI Provider — Premium cloud inference engine.
 *
 * Uses the Anthropic SDK to send structured prompts to Claude models
 * and validates the response against the ReviewFinding Zod schema.
 * Includes automatic retry logic with temperature reduction on schema failures.
 *
 * @see ai-provider.interface.ts for the contract.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './ai-provider.interface.js';
import type {
  ChunkAnalysisResult,
  CodeChunk,
  PromptConfig,
  ProviderCostMetrics,
  ReviewContext,
} from '../types/index.js';
import { ReviewFindingsArraySchema } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('claude-provider');

/** Maximum number of retries when the AI returns malformed JSON */
const MAX_RETRIES = 3;

/** Base temperature for inference (reduced on each retry) */
const BASE_TEMPERATURE = 0.3;

/**
 * Builds the full system prompt by injecting context variables into the template.
 *
 * @param prompt - The prompt template with {{variable}} placeholders.
 * @param context - The review context containing technology stack, guidelines, etc.
 * @returns The fully resolved system prompt string.
 */
function resolveSystemPrompt(prompt: PromptConfig, context: ReviewContext): string {
  let resolved = prompt.systemPrompt;

  // Inject technology stack details
  const techStackStr = context.technologyStack.languages
    .map((l) => `${l.name} (${l.percentage}%)`)
    .join(', ');
  resolved = resolved.replace('{{technology_stack}}', techStackStr);
  resolved = resolved.replace(
    '{{frameworks}}',
    context.technologyStack.frameworks.join(', ') || 'None detected'
  );
  resolved = resolved.replace(
    '{{repository_guidelines}}',
    context.repositoryGuidelines || 'No repository guidelines found.'
  );

  // Inject rule engine pre-findings
  const ruleFindings = context.ruleEngineFindings
    .map((f) => `[${f.severity.toUpperCase()}] ${f.message} (${f.filePath})`)
    .join('\n');
  resolved = resolved.replace(
    '{{rule_engine_findings}}',
    ruleFindings || 'No deterministic findings.'
  );

  return resolved;
}

/**
 * Builds the user prompt containing the actual code chunk to review.
 *
 * @param prompt - The prompt template.
 * @param chunk - The code chunk extracted from the AST.
 * @param context - The review context for PR metadata.
 * @returns The fully resolved user prompt string.
 */
function resolveUserPrompt(
  prompt: PromptConfig,
  chunk: CodeChunk,
  context: ReviewContext
): string {
  let resolved = prompt.userPrompt;

  resolved = resolved.replace('{{file_path}}', chunk.filePath);
  resolved = resolved.replace('{{node_type}}', chunk.nodeType);
  resolved = resolved.replace('{{node_name}}', chunk.nodeName ?? 'anonymous');
  resolved = resolved.replace('{{start_line}}', String(chunk.startLine));
  resolved = resolved.replace('{{end_line}}', String(chunk.endLine));
  resolved = resolved.replace('{{code_content}}', chunk.content);
  resolved = resolved.replace('{{surrounding_context}}', chunk.surroundingContext);
  resolved = resolved.replace(
    '{{changed_lines}}',
    chunk.changedLines.join(', ')
  );
  resolved = resolved.replace('{{pr_title}}', context.pullRequestMetadata.title);
  resolved = resolved.replace(
    '{{pr_description}}',
    context.pullRequestMetadata.description
  );

  const dependents = context.blastRadius?.[chunk.filePath];
  if (dependents && dependents.length > 0) {
    resolved = resolved.replace('{{blast_radius}}', dependents.join(', '));
  } else {
    resolved = resolved.replace('{{blast_radius}}', 'No dependencies found.');
  }

  return resolved;
}

/**
 * Anthropic Claude AI Provider implementation.
 * Uses Claude's Messages API with JSON output for reliable schema conformance.
 *
 * @implements {AIProvider}
 */
export class ClaudeProvider implements AIProvider {
  readonly name = 'Claude';

  private readonly client: Anthropic;
  private readonly modelName: string;

  // Accumulated cost tracking
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalInferenceMs = 0;

  /**
   * @param apiKey - The Anthropic API key.
   * @param modelName - The specific Claude model to use (default: claude-opus-4-20250514).
   */
  constructor(apiKey: string, modelName: string = 'claude-opus-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.modelName = modelName;
  }

  /**
   * Analyzes a code chunk by sending it to the Claude model with structured prompts.
   * Validates the JSON response against the ReviewFinding Zod schema.
   * Retries up to MAX_RETRIES times with reduced temperature on failure.
   *
   * @param prompt - Resolved prompt templates.
   * @param context - Enriched review context.
   * @param chunk - The semantic code chunk to analyze.
   * @returns An analysis result containing findings and optional PR metadata.
   * @throws Error if all retries are exhausted without valid output.
   */
  async analyzeChunk(
    prompt: PromptConfig,
    context: ReviewContext,
    chunk: CodeChunk
  ): Promise<ChunkAnalysisResult> {
    const systemPrompt = resolveSystemPrompt(prompt, context);
    const userPrompt = resolveUserPrompt(prompt, chunk, context);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const temperature = Math.max(0.1, BASE_TEMPERATURE - attempt * 0.1);
      const startTime = Date.now();

      try {
        const response = await this.client.messages.create({
          model: this.modelName,
          max_tokens: 4096,
          temperature,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt },
          ],
        });

        // Track inference timing
        this.totalInferenceMs += Date.now() - startTime;

        // Track token usage from the response metadata
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;

        // Extract text from the response content blocks
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        logger.debug({ chunkId: chunk.chunkId, responseLength: text.length }, `Claude response received`);

        // Claude may wrap JSON in markdown code fences — strip them
        const cleanedText = text
          .replace(/^```(?:json)?\s*\n?/m, '')
          .replace(/\n?```\s*$/m, '')
          .trim();

        // Parse and validate against the strict Zod schema
        const parsed = JSON.parse(cleanedText);

        // Extract PR-level metadata from the AI response
        const summary = typeof parsed.summary === 'string' ? parsed.summary : undefined;
        const risk = typeof parsed.risk === 'string' ? parsed.risk : undefined;
        const suggestedTests = Array.isArray(parsed.suggestedTests) ? parsed.suggestedTests : undefined;

        // Handle both array responses and wrapped object responses
        const findingsArray = Array.isArray(parsed)
          ? parsed
          : parsed.findings ?? parsed.issues ?? [parsed];

        // Filter out non-finding objects
        const validFindings = Array.isArray(findingsArray) && findingsArray.length > 0 && findingsArray[0]?.title
          ? findingsArray
          : [];

        const validated = ReviewFindingsArraySchema.parse(validFindings);

        // Enrich each finding with file/line context from the chunk
        const enrichedFindings = validated.map((finding) => ({
          ...finding,
          filePath: chunk.filePath,
          lineNumber: chunk.changedLines[0] ?? chunk.startLine,
          sourceChunkId: chunk.chunkId,
        }));

        return {
          findings: enrichedFindings,
          summary,
          risk,
          suggestedTests,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          { attempt: attempt + 1, maxRetries: MAX_RETRIES, err: lastError.message },
          `Claude attempt ${attempt + 1}/${MAX_RETRIES} failed`
        );

        // Handle rate limiting (429) with a backoff
        if (lastError.message.includes('429') || lastError.message.includes('rate')) {
          logger.info('Rate limited by Anthropic API. Sleeping for 30s before retry...');
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }
    }

    throw new Error(
      `[Claude] All ${MAX_RETRIES} retries exhausted for chunk ${chunk.chunkId}: ${lastError?.message}`
    );
  }

  /**
   * Claude is a cloud provider — supports parallel execution.
   *
   * @returns 'parallel'
   */
  getConcurrencyStrategy(): 'parallel' | 'sequential' {
    return 'parallel';
  }

  /**
   * Returns accumulated cost metrics for all inference calls.
   * Cost estimation uses approximate Claude Opus pricing.
   *
   * @returns Aggregated provider cost metrics.
   */
  getCostMetrics(): ProviderCostMetrics {
    // Approximate pricing for Claude Opus (per 1M tokens)
    const inputCostPerMillion = 15.0;
    const outputCostPerMillion = 75.0;

    const estimatedCostUsd =
      (this.totalInputTokens / 1_000_000) * inputCostPerMillion +
      (this.totalOutputTokens / 1_000_000) * outputCostPerMillion;

    return {
      provider: 'claude',
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      inferenceMs: this.totalInferenceMs,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
    };
  }
}
