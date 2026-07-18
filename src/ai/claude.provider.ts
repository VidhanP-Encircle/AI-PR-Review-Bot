/**
 * @module ai/claude.provider
 * Anthropic Claude AI Provider — Premium cloud inference engine.
 *
 * Uses the Anthropic SDK to send structured prompts to Claude models
 * and validates the response against the ReviewFinding Zod schema.
 * Includes automatic retry logic with temperature reduction on schema failures.
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
 */
function resolveSystemPrompt(prompt: PromptConfig, context: ReviewContext): string {
  let resolved = prompt.systemPrompt;
  const techStackStr = context.technologyStack.languages
    .map((l) => `${l.name} (${l.percentage}%)`)
    .join(', ');
  resolved = resolved.replace('{{technology_stack}}', techStackStr);
  resolved = resolved.replace('{{frameworks}}', context.technologyStack.frameworks.join(', ') || 'None detected');
  resolved = resolved.replace('{{repository_guidelines}}', context.repositoryGuidelines || 'No repository guidelines found.');
  const ruleFindings = context.ruleEngineFindings
    .map((f) => `[${f.severity.toUpperCase()}] ${f.message} (${f.filePath})`)
    .join('\n');
  resolved = resolved.replace('{{rule_engine_findings}}', ruleFindings || 'No deterministic findings.');
  return resolved;
}

/**
 * Builds the user prompt containing the actual code chunk to review.
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
  resolved = resolved.replace('{{changed_lines}}', chunk.changedLines.join(', '));
  resolved = resolved.replace('{{pr_title}}', context.pullRequestMetadata.title);
  resolved = resolved.replace('{{pr_description}}', context.pullRequestMetadata.description);
  const dependents = context.blastRadius?.[chunk.filePath];
  resolved = resolved.replace('{{blast_radius}}', dependents?.join(', ') || 'No dependencies found.');
  return resolved;
}

/**
 * Creates a Claude AI provider using the Anthropic SDK.
 * Uses Claude's Messages API with JSON output for reliable schema conformance.
 *
 * @param apiKey - The Anthropic API key.
 * @param modelName - The specific Claude model to use (default: claude-opus-4-20250514).
 * @returns An AIProvider configured for Claude.
 */
export function createClaudeProvider(
  apiKey: string,
  modelName: string = 'claude-opus-4-20250514'
): AIProvider {
  const client = new Anthropic({ apiKey });

  // Accumulated cost tracking (closure state)
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalInferenceMs = 0;

  const provider: AIProvider = {
    name: 'Claude',

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
          const response = await client.messages.create({
            model: modelName,
            max_tokens: 4096,
            temperature,
            system: systemPrompt,
            messages: [
              { role: 'user', content: userPrompt },
            ],
          });

          totalInferenceMs += Date.now() - startTime;
          totalInputTokens += response.usage.input_tokens;
          totalOutputTokens += response.usage.output_tokens;

          const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

          logger.debug({ chunkId: chunk.chunkId, responseLength: text.length }, `Claude response received`);

          const cleanedText = text
            .replace(/^```(?:json)?\s*\n?/m, '')
            .replace(/\n?```\s*$/m, '')
            .trim();

          const parsed = JSON.parse(cleanedText);

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

          return { findings: enrichedFindings, summary, risk, suggestedTests };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn(
            { attempt: attempt + 1, maxRetries: MAX_RETRIES, err: lastError.message },
            `Claude attempt ${attempt + 1}/${MAX_RETRIES} failed`
          );

          if (lastError.message.includes('429') || lastError.message.includes('rate')) {
            logger.info('Rate limited by Anthropic API. Sleeping for 30s before retry...');
            await new Promise(resolve => setTimeout(resolve, 30000));
          }
        }
      }

      throw new Error(
        `[Claude] All ${MAX_RETRIES} retries exhausted for chunk ${chunk.chunkId}: ${lastError?.message}`
      );
    },

    getConcurrencyStrategy(): 'parallel' | 'sequential' {
      return 'parallel';
    },

    getCostMetrics(): ProviderCostMetrics {
      const inputCostPerMillion = 15.0;
      const outputCostPerMillion = 75.0;
      const estimatedCostUsd =
        (totalInputTokens / 1_000_000) * inputCostPerMillion +
        (totalOutputTokens / 1_000_000) * outputCostPerMillion;

      return {
        provider: 'claude',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        inferenceMs: totalInferenceMs,
        estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      };
    },
  };

  return provider;
}
