import { expect, test, describe } from 'vitest';
import { mergeAndRankFindings } from './result-merger.js';
import type { EnrichedFinding } from '../types/index.js';

describe('Result Merger', () => {
  const makeFinding = (overrides: Partial<EnrichedFinding> = {}): EnrichedFinding => ({
    title: 'Test finding',
    severity: 'Medium',
    confidence: 85,
    impact: 'May cause incorrect behavior',
    evidence: 'Line 42: missing null check',
    recommendation: 'Add a null guard',
    filePath: 'src/file.ts',
    lineNumber: 42,
    sourceChunkId: 'chunk-1',
    ...overrides,
  });

  test('filters findings below confidence threshold', () => {
    const findings = [
      makeFinding({ title: 'Bug A', confidence: 90 }),
      makeFinding({ title: 'Bug B', confidence: 60 }),
      makeFinding({ title: 'Bug C', confidence: 30 }),
    ];

    const result = mergeAndRankFindings(findings, 70);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Bug A');
  });

  test('deduplicates findings with similar titles in same file', () => {
    const findings = [
      makeFinding({ title: 'Missing null check on user input validation', filePath: 'src/auth.ts', lineNumber: 15 }),
      makeFinding({ title: 'Missing null check on user input sanitize', filePath: 'src/auth.ts', lineNumber: 18 }),
      makeFinding({ title: 'Different finding altogether', filePath: 'src/auth.ts', lineNumber: 42 }),
    ];

    const result = mergeAndRankFindings(findings, 70);
    // First two titles share: missing, null, check, on, user, input (6/8 tokens = 0.75 >= 0.7 threshold)
    expect(result).toHaveLength(2); // First two should merge, third is unique
  });

  test('keeps finding with highest confidence when merging duplicates', () => {
    const findings = [
      makeFinding({ title: 'SQL injection risk in query', confidence: 70, filePath: 'src/db.ts', lineNumber: 10 }),
      makeFinding({ title: 'SQL injection risk in user query', confidence: 95, filePath: 'src/db.ts', lineNumber: 12 }),
    ];

    const result = mergeAndRankFindings(findings, 70);
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(95);
  });

  test('sorts findings by severity then confidence', () => {
    const findings = [
      makeFinding({ title: 'Low severity', severity: 'Low', confidence: 95 }),
      makeFinding({ title: 'Critical severity', severity: 'Critical', confidence: 80 }),
      makeFinding({ title: 'High severity', severity: 'High', confidence: 90 }),
    ];

    const result = mergeAndRankFindings(findings, 70);
    expect(result).toHaveLength(3);
    expect(result[0]!.severity).toBe('Critical');
    expect(result[1]!.severity).toBe('High');
    expect(result[2]!.severity).toBe('Low');
  });

  test('does not deduplicate findings from different files', () => {
    const findings = [
      makeFinding({ title: 'Missing error handling', filePath: 'src/handler.ts', lineNumber: 10 }),
      makeFinding({ title: 'Missing error handling', filePath: 'src/service.ts', lineNumber: 25 }),
    ];

    const result = mergeAndRankFindings(findings, 70);
    expect(result).toHaveLength(2);
  });

  test('returns empty array for empty input', () => {
    const result = mergeAndRankFindings([], 85);
    expect(result).toHaveLength(0);
  });

  test('returns empty array when all findings filtered', () => {
    const findings = [
      makeFinding({ confidence: 50 }),
      makeFinding({ confidence: 30 }),
    ];

    const result = mergeAndRankFindings(findings, 70);
    expect(result).toHaveLength(0);
  });
});
