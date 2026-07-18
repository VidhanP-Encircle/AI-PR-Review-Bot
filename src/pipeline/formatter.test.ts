import { expect, test, describe, vi, afterEach } from 'vitest';
import { renderReviewOutput } from './formatter.js';
import type { EnrichedFinding, ProviderCostMetrics, RuleEngineResult } from '../types/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Formatter', () => {
  const mockFinding: EnrichedFinding = {
    title: 'Missing null check',
    severity: 'Critical',
    confidence: 95,
    impact: 'Could cause TypeError at runtime',
    evidence: 'Line 42: user.name accessed without null guard',
    recommendation: 'Add optional chaining or null check',
    filePath: 'src/user.ts',
    lineNumber: 42,
    sourceChunkId: 'chunk-1',
    issueCode: 'return user.name;',
    suggestedFix: 'return user?.name;',
  };

  const mockMetrics: ProviderCostMetrics = {
    provider: 'gemini',
    inputTokens: 500,
    outputTokens: 200,
    inferenceMs: 3500,
    estimatedCostUsd: 0.00123,
  };

  function captureConsoleOutput(): string[] {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      output.push(args.join(' '));
    });
    return output;
  }

  test('renders without throwing when there are AI findings', () => {
    const output = captureConsoleOutput();
    renderReviewOutput([mockFinding], [], mockMetrics, 5);

    expect(output.length).toBeGreaterThan(0);
    expect(output.some((line) => line.includes('Missing null check'))).toBe(true);
  });

  test('renders success message when there are no findings', () => {
    const output = captureConsoleOutput();
    renderReviewOutput([], [], mockMetrics, 3);

    expect(output.some((line) => line.includes('clean'))).toBe(true);
  });

  test('renders rule engine findings when present', () => {
    const output = captureConsoleOutput();
    const ruleFindings: RuleEngineResult[] = [{
      ruleId: 'SEC-001',
      message: 'Hardcoded secret detected',
      filePath: 'src/config.ts',
      severity: 'high',
      blocking: true,
    }];

    renderReviewOutput([], ruleFindings, mockMetrics, 0);

    expect(output.some((line) => line.includes('SEC-001'))).toBe(true);
    expect(output.some((line) => line.includes('Hardcoded secret'))).toBe(true);
  });

  test('renders cost metrics', () => {
    const output = captureConsoleOutput();
    renderReviewOutput([], [], mockMetrics, 0);

    expect(output.some((line) => line.includes('gemini'))).toBe(true);
    expect(output.some((line) => line.includes('500'))).toBe(true);
  });
});
