/**
 * @module ai/fallback-provider
 * Fallback AI Provider — Wraps a primary provider with automatic fallback.
 *
 * If the primary provider exhausts all retries or throws a non-recoverable
 * error, the fallback provider takes over automatically. This ensures
 * reviews are not blocked by a single provider outage.
 *
 * Usage:
 *   AI_FALLBACK_PROVIDER=openrouter
 *   AI_FALLBACK_MODEL=openai/gpt-4o-mini
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

const logger = getLogger('fallback-provider');

/**
 * Creates a FallbackProvider that wraps a primary AI provider and automatically
 * falls back to a secondary (fallback) provider if the primary exhausts retries
 * or throws a fatal error.
 *
 * The fallback is transparent to the caller — the same `analyzeChunk` API
 * is used, and if the fallback kicks in, the result still returns normally.
 * Cost metrics are aggregated across both providers.
 *
 * @param primary - The primary AI provider to attempt first.
 * @param fallback - The secondary AI provider to use if the primary fails.
 * @returns An AIProvider that delegates to primary, falling back on failure.
 */
export function createFallbackProvider(
  primary: AIProvider,
  fallback: AIProvider
): AIProvider {
  const name = `${primary.name}+${fallback.name}`;

  const provider: AIProvider = {
    name,

    async analyzeChunk(
      prompt: PromptConfig,
      context: ReviewContext,
      chunk: CodeChunk
    ): Promise<ChunkAnalysisResult> {
      try {
        logger.info(
          { provider: primary.name, chunkId: chunk.chunkId },
          `Attempting primary provider: ${primary.name}`
        );
        const result = await primary.analyzeChunk(prompt, context, chunk);
        return result;
      } catch (primaryError) {
        logger.warn(
          { provider: primary.name, chunkId: chunk.chunkId, err: primaryError },
          `Primary provider ${primary.name} failed. Falling back to ${fallback.name}.`
        );

        try {
          const result = await fallback.analyzeChunk(prompt, context, chunk);
          return result;
        } catch (fallbackError) {
          logger.error(
            { primary: primary.name, fallback: fallback.name, chunkId: chunk.chunkId, err: fallbackError },
            `Both primary and fallback providers exhausted for chunk ${chunk.chunkId}`
          );
          throw new Error(
            `[FallbackProvider] Both providers exhausted for chunk ${chunk.chunkId}. ` +
            `Primary (${primary.name}): ${primaryError}. ` +
            `Fallback (${fallback.name}): ${fallbackError}`
          );
        }
      }
    },

    getConcurrencyStrategy(): 'parallel' | 'sequential' {
      return primary.getConcurrencyStrategy();
    },

    getCostMetrics(): ProviderCostMetrics {
      const p = primary.getCostMetrics();
      const f = fallback.getCostMetrics();

      return {
        provider: name,
        inputTokens: p.inputTokens + f.inputTokens,
        outputTokens: p.outputTokens + f.outputTokens,
        inferenceMs: p.inferenceMs + f.inferenceMs,
        estimatedCostUsd: p.estimatedCostUsd + f.estimatedCostUsd,
      };
    },
  };

  return provider;
}
