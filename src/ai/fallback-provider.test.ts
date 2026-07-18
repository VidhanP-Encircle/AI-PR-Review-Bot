import { expect, test, describe, vi } from 'vitest';
import { createFallbackProvider } from './fallback-provider.js';
import type { AIProvider } from './ai-provider.interface.js';
import type { ChunkAnalysisResult, PromptConfig, ReviewContext, CodeChunk } from '../types/index.js';

const createMockProvider = (name: string, shouldFail = false): AIProvider => ({
  name,
  getConcurrencyStrategy: () => 'parallel' as const,
  getCostMetrics: () => ({
    provider: name,
    inputTokens: 100,
    outputTokens: 50,
    inferenceMs: 1000,
    estimatedCostUsd: 0.001,
  }),
  analyzeChunk: async () => {
    if (shouldFail) {
      throw new Error(`${name} failed`);
    }
    return {
      findings: [],
      summary: 'Clean code',
      risk: 'Low',
      suggestedTests: ['Test 1'],
    } satisfies ChunkAnalysisResult;
  },
});

const mockPrompt: PromptConfig = {
  name: 'test',
  version: '1.0.0',
  systemPrompt: 'Review code',
  userPrompt: '{{code_content}}',
};

const mockContext: ReviewContext = {
  pullRequestMetadata: { title: 'Test PR', description: 'Test', author: 'user' },
  technologyStack: {
    languages: [{ name: 'TypeScript', percentage: 100 }],
    frameworks: [],
    testingLibraries: [],
    packageManagers: [],
    linters: [],
  },
  repositoryGuidelines: '',
  ruleEngineFindings: [],
};

const mockChunk: CodeChunk = {
  chunkId: 'test-1',
  filePath: 'src/test.ts',
  nodeType: 'function',
  nodeName: 'testFunc',
  startLine: 1,
  endLine: 10,
  content: 'function test() {}',
  surroundingContext: '',
  changedLines: [5, 6, 7],
};

describe('FallbackProvider', () => {
  test('uses primary provider when it succeeds', async () => {
    const primary = createMockProvider('Gemini');
    const fallback = createMockProvider('Claude');
    const provider = createFallbackProvider(primary, fallback);

    const result = await provider.analyzeChunk(mockPrompt, mockContext, mockChunk);
    expect(result.summary).toBe('Clean code');
    expect(result.risk).toBe('Low');
  });

  test('falls back to secondary when primary fails', async () => {
    const primary = createMockProvider('Gemini', true);
    const fallback = createMockProvider('Claude');
    const provider = createFallbackProvider(primary, fallback);

    const result = await provider.analyzeChunk(mockPrompt, mockContext, mockChunk);
    expect(result.summary).toBe('Clean code');
  });

  test('throws error when both providers fail', async () => {
    const primary = createMockProvider('Gemini', true);
    const fallback = createMockProvider('Claude', true);
    const provider = createFallbackProvider(primary, fallback);

    await expect(provider.analyzeChunk(mockPrompt, mockContext, mockChunk)).rejects.toThrow(
      'Both providers exhausted'
    );
  });

  test('aggregates cost metrics across both providers', async () => {
    const primary = createMockProvider('Gemini');
    const fallback = createMockProvider('Claude');
    const provider = createFallbackProvider(primary, fallback);

    // Run a successful call through primary
    await provider.analyzeChunk(mockPrompt, mockContext, mockChunk);

    const metrics = provider.getCostMetrics();
    expect(metrics.provider).toBe('Gemini+Claude');
    expect(metrics.inputTokens).toBe(200); // 100 from primary + 100 from fallback
    expect(metrics.outputTokens).toBe(100); // 50 from primary + 50 from fallback
  });

  test('aggregates metrics when fallback was used', async () => {
    const primary = createMockProvider('Gemini', true);
    const fallback = createMockProvider('Claude');
    const provider = createFallbackProvider(primary, fallback);

    // This should succeed via fallback
    await provider.analyzeChunk(mockPrompt, mockContext, mockChunk);

    const metrics = provider.getCostMetrics();
    expect(metrics.provider).toBe('Gemini+Claude');
    expect(metrics.inputTokens).toBe(200);
    expect(metrics.outputTokens).toBe(100);
  });

  test('uses primary concurrency strategy', () => {
    const primary = createMockProvider('Gemini');
    const fallback = createMockProvider('Claude');
    const provider = createFallbackProvider(primary, fallback);

    expect(provider.getConcurrencyStrategy()).toBe('parallel');
  });

  test('logs provider name correctly', () => {
    const primary = createMockProvider('Gemini');
    const fallback = createMockProvider('Claude');
    const provider = createFallbackProvider(primary, fallback);

    expect(provider.name).toBe('Gemini+Claude');
  });
});
