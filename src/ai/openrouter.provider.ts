/**
 * @module ai/openrouter.provider
 * OpenRouter AI Provider — Inference via OpenRouter API.
 *
 * Compatible with OpenAI chat completions format.
 * Uses standard fetch for API communication.
 */

import { getLogger } from '../utils/logger.js';
import type { AIProvider } from './ai-provider.interface.js';
import type {
  ChunkAnalysisResult,
  CodeChunk,
  PromptConfig,
  ProviderCostMetrics,
  ReviewContext,
} from '../types/index.js';
import { ReviewFindingsArraySchema } from '../types/index.js';

const logger = getLogger('openrouter-provider');

const MAX_RETRIES = 3;
const BASE_TEMPERATURE = 0.3;

/**
 * Resolves the system prompt by injecting context variables.
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
  resolved = resolved.replace('{{rule_engine_findings}}', ruleFindings || 'No automated findings.');
  return resolved;
}

/**
 * Resolves the user prompt by injecting chunk and PR context.
 */
function resolveUserPrompt(prompt: PromptConfig, chunk: CodeChunk, context: ReviewContext): string {
  let resolved = prompt.userPrompt;
  resolved = resolved.replace('{{file_path}}', chunk.filePath);
  resolved = resolved.replace('{{node_type}}', chunk.nodeType);
  resolved = resolved.replace('{{node_name}}', chunk.nodeName || 'unknown');
  resolved = resolved.replace('{{start_line}}', chunk.startLine.toString());
  resolved = resolved.replace('{{end_line}}', chunk.endLine.toString());
  resolved = resolved.replace('{{surrounding_context}}', chunk.surroundingContext || '');
  resolved = resolved.replace('{{code_content}}', chunk.content);
  resolved = resolved.replace('{{pr_title}}', context.pullRequestMetadata?.title || 'No title provided');
  resolved = resolved.replace('{{changed_lines}}', chunk.changedLines.length > 0 ? chunk.changedLines.join(', ') : 'All lines');
  const dependents = context.blastRadius?.[chunk.filePath];
  resolved = resolved.replace('{{blast_radius}}', dependents?.join(', ') || 'No dependencies found.');
  return resolved;
}

/**
 * Creates an OpenRouter AI provider using standard fetch.
 * Compatible with OpenAI chat completions format.
 *
 * @param apiKey - The OpenRouter API key.
 * @param modelName - The model to use (e.g., "openai/gpt-4o-mini").
 * @returns An AIProvider configured for OpenRouter.
 */
export function createOpenRouterProvider(
  apiKey: string,
  modelName: string
): AIProvider {
  // Accumulated cost tracking (closure state)
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalInferenceMs = 0;

  const provider: AIProvider = {
    name: 'OpenRouter',

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
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://github.com/vidhan/AI-Review-Bot',
              'X-Title': 'AI PR Review Bot',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: modelName,
              temperature,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
          }

          const result = (await response.json()) as any;

          totalInferenceMs += Date.now() - startTime;

          if (result.usage) {
            totalInputTokens += result.usage.prompt_tokens || 0;
            totalOutputTokens += result.usage.completion_tokens || 0;
          }

          const text = result.choices[0]?.message?.content || '';

          logger.debug({ chunkId: chunk.chunkId, responseLength: text.length }, `OpenRouter response received`);

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
            `OpenRouter attempt ${attempt + 1}/${MAX_RETRIES} failed`
          );

          if (lastError.message.includes('429') || lastError.message.includes('rate limit')) {
            logger.info('Rate limited by OpenRouter API. Sleeping for 15s before retry...');
            await new Promise(resolve => setTimeout(resolve, 15000));
          }
        }
      }

      throw new Error(
        `[OpenRouter] All ${MAX_RETRIES} retries exhausted for chunk ${chunk.chunkId}: ${lastError?.message}`
      );
    },

    getConcurrencyStrategy(): 'parallel' | 'sequential' {
      return 'parallel';
    },

    getCostMetrics(): ProviderCostMetrics {
      return {
        provider: 'OpenRouter',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCostUsd: 0,
        inferenceMs: totalInferenceMs,
      };
    },
  };

  return provider;
}
