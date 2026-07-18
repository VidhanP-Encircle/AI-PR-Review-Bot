/**
 * @module ai/ai-provider.factory
 * Centralized AI Provider Factory.
 *
 * Resolves the configured AI provider from environment variables and returns
 * a fully initialized instance. This is the single source of truth for
 * provider resolution — both the CLI and server use this factory.
 *
 * To add a new provider:
 * 1. Create a new file implementing the `AIProvider` interface.
 * 2. Add a case to the `switch` statement below.
 * 3. Add the env var to `.env.example`.
 *
 * @see ai-provider.interface.ts for the contract all providers must implement.
 */

import type { AIProvider } from './ai-provider.interface.js';
import { GeminiProvider } from './gemini.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import { ClaudeProvider } from './claude.provider.js';
import { OpenRouterProvider } from './openrouter.provider.js';

/**
 * Creates and returns an AI provider instance based on environment configuration.
 *
 * Reads `AI_PROVIDER` to determine which provider to instantiate and
 * `AI_MODEL` for an optional model override.
 *
 * @returns An initialized AIProvider ready for inference.
 * @throws Error if the provider name is unrecognized or required env vars are missing.
 */
export function createAIProvider(): AIProvider {
  const providerName = process.env.AI_PROVIDER ?? 'gemini';
  const model = process.env.AI_MODEL;

  switch (providerName.toLowerCase()) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'GEMINI_API_KEY is required when AI_PROVIDER=gemini. Set it in your .env file.'
        );
      }
      return new GeminiProvider(apiKey, model ?? 'gemini-2.5-flash');
    }

    case 'claude': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is required when AI_PROVIDER=claude. Set it in your .env file.'
        );
      }
      return new ClaudeProvider(apiKey, model ?? 'claude-opus-4-20250514');
    }

    case 'ollama': {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      return new OllamaProvider(model ?? 'deepseek-coder-v2', baseUrl);
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter. Set it in your .env file.'
        );
      }
      return new OpenRouterProvider(apiKey, model ?? 'openai/gpt-4o-mini');
    }

    default:
      throw new Error(
        `Unknown AI_PROVIDER: "${providerName}". Supported: gemini, claude, ollama, openrouter`
      );
  }
}
