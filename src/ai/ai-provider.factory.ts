/**
 * @module ai/ai-provider.factory
 * Centralized AI Provider Factory.
 *
 * Resolves the configured AI provider from environment variables and returns
 * a fully initialized instance. This is the single source of truth for
 * provider resolution — both the CLI and server use this factory.
 *
 * Supports automatic fallback: if AI_FALLBACK_PROVIDER is set and the
 * primary provider exhausts retries, the fallback provider is used.
 *
 * To add a new provider:
 * 1. Create a new file implementing the `AIProvider` interface.
 * 2. Add a case to the `switch` statement below.
 * 3. Add the env var to `.env.example`.
 *
 * @see ai-provider.interface.ts for the contract all providers must implement.
 */

import type { AIProvider } from './ai-provider.interface.js';
import { createFallbackProvider } from './fallback-provider.js';
import { createGeminiProvider } from './gemini.provider.js';
import { createOllamaProvider } from './ollama.provider.js';
import { createClaudeProvider } from './claude.provider.js';
import { createOpenRouterProvider } from './openrouter.provider.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ai-provider-factory');

/**
 * Creates a single provider instance by name.
 * Internal helper used by createAIProvider and createFallbackProvider.
 *
 * @param providerName - The provider name (gemini, claude, ollama, openrouter).
 * @param modelOverride - Optional model override.
 * @returns An initialized AIProvider.
 * @throws Error if the provider name is unrecognized or required env vars are missing.
 */
function createSingleProvider(providerName: string, modelOverride?: string): AIProvider {
  const model = modelOverride ?? process.env.AI_MODEL;

  switch (providerName.toLowerCase()) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'GEMINI_API_KEY is required when AI_PROVIDER=gemini. Set it in your .env file.'
        );
      }
      return createGeminiProvider(apiKey, model ?? 'gemini-2.5-flash');
    }

    case 'claude': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is required when AI_PROVIDER=claude. Set it in your .env file.'
        );
      }
      return createClaudeProvider(apiKey, model ?? 'claude-opus-4-20250514');
    }

    case 'ollama': {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      return createOllamaProvider(model ?? 'deepseek-coder-v2', baseUrl);
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter. Set it in your .env file.'
        );
      }
      return createOpenRouterProvider(apiKey, model ?? 'openai/gpt-4o-mini');
    }

    default:
      throw new Error(
        `Unknown AI provider: "${providerName}". Supported: gemini, claude, ollama, openrouter`
      );
  }
}

/**
 * Creates and returns an AI provider instance based on environment configuration.
 *
 * Primary provider is determined by `AI_PROVIDER` (default: gemini).
 * If `AI_FALLBACK_PROVIDER` is set, the primary and fallback are wrapped
 * in a FallbackProvider for automatic failover on exhaustion.
 *
 * @returns An initialized AIProvider (possibly with fallback wrapper).
 * @throws Error if the provider name is unrecognized or required env vars are missing.
 */
export function createAIProvider(): AIProvider {
  const providerName = process.env.AI_PROVIDER ?? 'gemini';
  const fallbackName = process.env.AI_FALLBACK_PROVIDER;

  // Create the primary provider
  const primary = createSingleProvider(providerName);

  // If no fallback configured, return the primary directly
  if (!fallbackName) {
    logger.info(`AI provider: ${primary.name} (no fallback configured)`);
    return primary;
  }

  // Create the fallback provider
  try {
    const fallback = createSingleProvider(fallbackName, process.env.AI_FALLBACK_MODEL);
    const wrapped = createFallbackProvider(primary, fallback);
    logger.info(`AI provider: ${primary.name} → fallback: ${fallback.name} (auto-failover enabled)`);
    return wrapped;
  } catch (err) {
    logger.warn(
      { fallbackName, err },
      `Failed to configure fallback provider "${fallbackName}". Running without fallback.`
    );
    return primary;
  }
}

export { createFallbackProvider, createSingleProvider };
