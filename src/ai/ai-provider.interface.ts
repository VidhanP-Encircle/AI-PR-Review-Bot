/**
 * @module ai/ai-provider.interface
 * Abstract AI Provider interface for vendor-agnostic LLM inference.
 *
 * All AI interactions in the system pass through this interface,
 * ensuring the core review engine remains completely decoupled from
 * any specific LLM vendor (Gemini, OpenAI, Ollama, Anthropic).
 *
 * @see 08_AI_PROVIDER_AND_PROMPT_REGISTRY.md for architecture.
 */

import type {
  ChunkAnalysisResult,
  CodeChunk,
  PromptConfig,
  ProviderCostMetrics,
  ReviewContext,
} from '../types/index.js';

/**
 * Abstract interface that all AI providers must implement.
 * Standardizes the input (Context + Chunk + Prompt) and output (Structured Findings)
 * regardless of the underlying LLM.
 */
export interface AIProvider {
  /**
   * The display name of this provider (e.g., "Gemini", "Ollama").
   * Used for logging and telemetry identification.
   */
  readonly name: string;

  /**
   * Analyzes a single code chunk using the AI model.
   * Returns structured findings validated against the ReviewFinding Zod schema,
   * along with optional PR-level metadata (summary, risk, suggestedTests).
   *
   * Business Rule: If the AI returns malformed JSON, the provider must
   * retry with reduced temperature before throwing an error.
   *
   * @param prompt - The resolved prompt templates from the Prompt Registry.
   * @param context - The enriched review context from the Context Builder.
   * @param chunk - The semantic code chunk from the Chunking Engine.
   * @returns An analysis result containing findings and optional PR metadata.
   */
  analyzeChunk(
    prompt: PromptConfig,
    context: ReviewContext,
    chunk: CodeChunk
  ): Promise<ChunkAnalysisResult>;

  /**
   * Returns the concurrency strategy for this provider.
   * - "parallel": Cloud providers (Gemini, OpenAI) — fire multiple requests simultaneously.
   * - "sequential": Local providers (Ollama) — process one chunk at a time to avoid VRAM exhaustion.
   *
   * @returns The concurrency strategy identifier.
   */
  getConcurrencyStrategy(): 'parallel' | 'sequential';

  /**
   * Returns the accumulated cost metrics from all inference calls
   * made by this provider instance.
   *
   * @returns Aggregated cost and usage metrics.
   */
  getCostMetrics(): ProviderCostMetrics;
}
