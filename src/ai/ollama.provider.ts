/**
 * @module ai/ollama.provider
 * Ollama AI Provider — Local inference engine for air-gapped deployments.
 *
 * Uses the Ollama REST API to run inference against locally hosted models.
 * Enforces sequential execution to prevent VRAM exhaustion on consumer GPUs.
 *
 * @see 08_AI_PROVIDER_AND_PROMPT_REGISTRY.md Section 4.2 for concurrency rules.
 */

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

const logger = getLogger('ollama-provider');

/** Maximum number of retries when the model returns malformed JSON */
const MAX_RETRIES = 3;

/** Default Ollama API base URL */
const DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Builds the combined prompt string for Ollama's chat API.
 * Ollama's API is simpler than cloud providers, so we combine
 * system and user prompts into a structured message array.
 *
 * @param prompt - The prompt templates.
 * @param context - The review context.
 * @param chunk - The code chunk to analyze.
 * @returns A messages array compatible with Ollama's chat API.
 */
function buildMessages(
  prompt: PromptConfig,
  context: ReviewContext,
  chunk: CodeChunk
): Array<{ role: string; content: string }> {
  // Build system prompt with context injection
  let systemContent = prompt.systemPrompt;
  const techStackStr = context.technologyStack.languages
    .map((l) => `${l.name} (${l.percentage}%)`)
    .join(', ');
  systemContent = systemContent.replace('{{technology_stack}}', techStackStr);
  systemContent = systemContent.replace(
    '{{frameworks}}',
    context.technologyStack.frameworks.join(', ') || 'None detected'
  );
  systemContent = systemContent.replace(
    '{{repository_guidelines}}',
    context.repositoryGuidelines || 'No repository guidelines found.'
  );
  const ruleFindings = context.ruleEngineFindings
    .map((f) => `[${f.severity.toUpperCase()}] ${f.message} (${f.filePath})`)
    .join('\n');
  systemContent = systemContent.replace(
    '{{rule_engine_findings}}',
    ruleFindings || 'No deterministic findings.'
  );

  // Build user prompt with chunk injection
  let userContent = prompt.userPrompt;
  userContent = userContent.replace('{{file_path}}', chunk.filePath);
  userContent = userContent.replace('{{node_type}}', chunk.nodeType);
  userContent = userContent.replace('{{node_name}}', chunk.nodeName ?? 'anonymous');
  userContent = userContent.replace('{{start_line}}', String(chunk.startLine));
  userContent = userContent.replace('{{end_line}}', String(chunk.endLine));
  userContent = userContent.replace('{{code_content}}', chunk.content);
  userContent = userContent.replace('{{surrounding_context}}', chunk.surroundingContext);
  userContent = userContent.replace(
    '{{changed_lines}}',
    chunk.changedLines.join(', ')
  );
  let resolved = userContent.replace('{{pr_title}}', context.pullRequestMetadata.title);
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

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: resolved },
  ];
}

/**
 * Ollama AI Provider for local, privacy-first inference.
 *
 * Business Rule: This provider ALWAYS returns 'sequential' for concurrency
 * to prevent VRAM exhaustion. BullMQ workers should limit concurrency to 1
 * when using this provider.
 *
 * @implements {AIProvider}
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'Ollama';

  private readonly baseUrl: string;
  private readonly modelName: string;

  // Accumulated metrics
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalInferenceMs = 0;

  /**
   * @param modelName - The Ollama model to use (e.g., "deepseek-coder-v2").
   * @param baseUrl - The Ollama REST API base URL (default: http://localhost:11434).
   */
  constructor(
    modelName: string = 'deepseek-coder-v2',
    baseUrl: string = DEFAULT_BASE_URL
  ) {
    this.modelName = modelName;
    this.baseUrl = baseUrl;
  }

  /**
   * Analyzes a code chunk using the local Ollama instance.
   * Requests JSON output format and validates against the ReviewFinding schema.
   *
   * @param prompt - Resolved prompt templates.
   * @param context - Enriched review context.
   * @param chunk - The semantic code chunk to analyze.
   * @returns An array of enriched findings with file/line attribution.
   * @throws Error if all retries are exhausted.
   */
  async analyzeChunk(
    prompt: PromptConfig,
    context: ReviewContext,
    chunk: CodeChunk
  ): Promise<ChunkAnalysisResult> {
    const messages = buildMessages(prompt, context, chunk);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const temperature = Math.max(0.1, 0.3 - attempt * 0.1);
      const startTime = Date.now();

      try {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.modelName,
            messages,
            format: 'json',
            stream: false,
            options: { temperature },
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        };

        this.totalInferenceMs += Date.now() - startTime;

        // Track token metrics from Ollama response
        this.totalInputTokens += data.prompt_eval_count ?? 0;
        this.totalOutputTokens += data.eval_count ?? 0;

        const text = data.message?.content ?? '';
        const parsed = JSON.parse(text);

        const summary = typeof parsed.summary === 'string' ? parsed.summary : undefined;
        const risk = typeof parsed.risk === 'string' ? parsed.risk : undefined;
        const suggestedTests = Array.isArray(parsed.suggestedTests) ? parsed.suggestedTests : undefined;

        const findingsArray = Array.isArray(parsed)
          ? parsed
          : parsed.findings ?? parsed.issues ?? [parsed];

        const validFindings = Array.isArray(findingsArray) && findingsArray.length > 0 && findingsArray[0]?.title
          ? findingsArray
          : [];

        const validated = ReviewFindingsArraySchema.parse(validFindings);

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
          `Ollama attempt ${attempt + 1}/${MAX_RETRIES} failed`
        );
      }
    }

    throw new Error(
      `[Ollama] All ${MAX_RETRIES} retries exhausted for chunk ${chunk.chunkId}: ${lastError?.message}`
    );
  }

  /**
   * Ollama is a local provider — MUST use sequential execution.
   * @returns 'sequential'
   */
  getConcurrencyStrategy(): 'parallel' | 'sequential' {
    return 'sequential';
  }

  /**
   * Returns accumulated cost metrics. Ollama is free to run locally,
   * so estimatedCostUsd is always 0.
   *
   * @returns Aggregated provider cost metrics.
   */
  getCostMetrics(): ProviderCostMetrics {
    return {
      provider: 'ollama',
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      inferenceMs: this.totalInferenceMs,
      estimatedCostUsd: 0,
    };
  }
}
