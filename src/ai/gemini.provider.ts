/**
 * @module ai/gemini.provider
 * Gemini AI Provider — Primary cloud inference engine.
 *
 * Uses the Google Generative AI SDK to send structured prompts to Gemini models
 * and validates the response against the ReviewFinding Zod schema.
 * Includes automatic retry logic with temperature reduction on schema failures.
 *
 * @see 08_AI_PROVIDER_AND_PROMPT_REGISTRY.md for architecture.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIProvider } from './ai-provider.interface.js';
import type {
  ChunkAnalysisResult,
  CodeChunk,
  EnrichedFinding,
  PromptConfig,
  ProviderCostMetrics,
  ReviewContext,
} from '../types/index.js';
import { ReviewFindingsArraySchema } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('gemini-provider');

/** Maximum number of retries when the AI returns malformed JSON or gets rate limited */
const MAX_RETRIES = 5;

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
 * Google Gemini AI Provider implementation.
 * Uses structured JSON output mode to ensure reliable schema conformance.
 *
 * @implements {AIProvider}
 */
export class GeminiProvider implements AIProvider {
  readonly name = 'Gemini';

  private readonly client: GoogleGenerativeAI;
  private readonly modelName: string;

  // Accumulated cost tracking
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalInferenceMs = 0;

  /**
   * @param apiKey - The Google Gemini API key.
   * @param modelName - The specific Gemini model to use (default: gemini-2.5-flash).
   */
  constructor(apiKey: string, modelName: string = 'gemini-2.5-flash') {
    this.client = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  /**
   * Analyzes a code chunk by sending it to the Gemini model with structured prompts.
   * Validates the JSON response against the ReviewFinding Zod schema.
   * Retries up to MAX_RETRIES times with reduced temperature on failure.
   *
   * @param prompt - Resolved prompt templates.
   * @param context - Enriched review context.
   * @param chunk - The semantic code chunk to analyze.
   * @returns An array of enriched findings with file/line attribution.
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
        const model = this.client.getGenerativeModel({
          model: this.modelName,
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
          },
          systemInstruction: systemPrompt,
        });

        const result = await model.generateContent(userPrompt);
        const response = result.response;
        const text = response.text();
        logger.debug({ chunkId: chunk.chunkId, responseLength: text.length }, `Gemini response received`);

        // Track inference timing
        this.totalInferenceMs += Date.now() - startTime;

        // Track token usage from the response metadata
        const usageMetadata = response.usageMetadata;
        if (usageMetadata) {
          this.totalInputTokens += usageMetadata.promptTokenCount ?? 0;
          this.totalOutputTokens += usageMetadata.candidatesTokenCount ?? 0;
        }

        // Parse and validate against the strict Zod schema
        const parsed = JSON.parse(text);

        // Extract PR-level metadata from the AI response
        const summary = typeof parsed.summary === 'string' ? parsed.summary : undefined;
        const risk = typeof parsed.risk === 'string' ? parsed.risk : undefined;
        const suggestedTests = Array.isArray(parsed.suggestedTests) ? parsed.suggestedTests : undefined;

        // Handle both array responses and wrapped object responses
        const findingsArray = Array.isArray(parsed)
          ? parsed
          : parsed.findings ?? parsed.issues ?? [parsed];

        // Filter out non-finding objects (in case the top-level object itself was treated as a finding)
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
        // Log retry attempt (will use Pino in Phase 4)
        logger.warn(
          { attempt: attempt + 1, maxRetries: MAX_RETRIES, err: lastError.message },
          `Gemini attempt ${attempt + 1}/${MAX_RETRIES} failed`
        );
        if (lastError.message.includes('429') || lastError.message.includes('503')) {
          // Attempt to parse Google's explicit retry delay from the error message
          // e.g., "Please retry in 45.32071446s."
          const retryMatch = lastError.message.match(/Please retry in (\d+\.?\d*)s/);
          let backoff = 60000; // Default to 60s for RPM limits

          if (retryMatch && retryMatch[1]) {
            // Parse the requested seconds, add a 2 second safety buffer, and add random jitter
            backoff = (parseFloat(retryMatch[1]) + 2) * 1000 + Math.random() * 8000;
          } else {
            // Fallback to standard jittered backoff
            backoff = 60000 + (attempt * 15000) + Math.random() * 8000;
          }

          logger.info(`Rate limited or overloaded (429/503) by Gemini API. Sleeping for ${Math.round(backoff / 1000)}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(
      `[Gemini] All ${MAX_RETRIES} retries exhausted for chunk ${chunk.chunkId}: ${lastError?.message}`
    );
  }

  /**
   * Gemini Free Tier has a strict 15 RPM limit.
   * Sequential execution prevents bursting the rate limit instantly.
   * @returns 'sequential'
   */
  getConcurrencyStrategy(): 'parallel' | 'sequential' {
    return process.env.GEMINI_TIER === 'paid' ? 'parallel' : 'sequential';
  }

  /**
   * Returns accumulated cost metrics for all inference calls.
   * Cost estimation uses approximate Gemini 2.5 Flash pricing.
   *
   * @returns Aggregated provider cost metrics.
   */
  getCostMetrics(): ProviderCostMetrics {
    // Approximate pricing for Gemini 2.5 Flash (per 1M tokens)
    const inputCostPerMillion = 0.15;
    const outputCostPerMillion = 0.60;

    const estimatedCostUsd =
      (this.totalInputTokens / 1_000_000) * inputCostPerMillion +
      (this.totalOutputTokens / 1_000_000) * outputCostPerMillion;

    return {
      provider: 'gemini',
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      inferenceMs: this.totalInferenceMs,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
    };
  }
}
