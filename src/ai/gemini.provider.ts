/**
 * @module ai/gemini.provider
 * Gemini AI Provider — Primary cloud inference engine.
 *
 * Uses the Google Generative AI SDK to send structured prompts to Gemini models
 * and validates the response against the ReviewFinding Zod schema.
 * Includes automatic retry logic with temperature reduction on schema failures.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
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

const logger = getLogger('gemini-provider');

/** Maximum number of retries when the AI returns malformed JSON or gets rate limited */
const MAX_RETRIES = 5;

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
 * Creates a Gemini AI provider using the Google Generative AI SDK.
 * Uses structured JSON output mode to ensure reliable schema conformance.
 *
 * @param apiKey - The Google Gemini API key.
 * @param modelName - The specific Gemini model to use (default: gemini-2.5-flash).
 * @returns An AIProvider configured for Gemini.
 */
export function createGeminiProvider(
  apiKey: string,
  modelName: string = 'gemini-2.5-flash'
): AIProvider {
  const client = new GoogleGenerativeAI(apiKey);

  // Accumulated cost tracking (closure state)
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalInferenceMs = 0;

  const provider: AIProvider = {
    name: 'Gemini',

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
          const model = client.getGenerativeModel({
            model: modelName,
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

          totalInferenceMs += Date.now() - startTime;

          const usageMetadata = response.usageMetadata;
          if (usageMetadata) {
            totalInputTokens += usageMetadata.promptTokenCount ?? 0;
            totalOutputTokens += usageMetadata.candidatesTokenCount ?? 0;
          }

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

          return { findings: enrichedFindings, summary, risk, suggestedTests };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn(
            { attempt: attempt + 1, maxRetries: MAX_RETRIES, err: lastError.message },
            `Gemini attempt ${attempt + 1}/${MAX_RETRIES} failed`
          );
          if (lastError.message.includes('429') || lastError.message.includes('503')) {
            const retryMatch = lastError.message.match(/Please retry in (\d+\.?\d*)s/);
            let backoff = 60000;
            if (retryMatch && retryMatch[1]) {
              backoff = (parseFloat(retryMatch[1]) + 2) * 1000 + Math.random() * 8000;
            } else {
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
    },

    getConcurrencyStrategy(): 'parallel' | 'sequential' {
      return process.env.GEMINI_TIER === 'paid' ? 'parallel' : 'sequential';
    },

    getCostMetrics(): ProviderCostMetrics {
      const inputCostPerMillion = 0.15;
      const outputCostPerMillion = 0.60;
      const estimatedCostUsd =
        (totalInputTokens / 1_000_000) * inputCostPerMillion +
        (totalOutputTokens / 1_000_000) * outputCostPerMillion;

      return {
        provider: 'gemini',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        inferenceMs: totalInferenceMs,
        estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      };
    },
  };

  return provider;
}
