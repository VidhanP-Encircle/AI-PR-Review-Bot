import { expect, test, describe } from 'vitest';
import { calculateReviewScore } from './score-calculator.js';
import type { ReviewFinding } from '../types/index.js';

const makeFinding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  title: 'Test finding',
  severity: 'Medium',
  confidence: 85,
  impact: 'May cause issues',
  evidence: 'Evidence text',
  recommendation: 'Fix it',
  ...overrides,
});

describe('Score Calculator', () => {
  test('perfect code scores 10', () => {
    const result = calculateReviewScore([]);
    expect(result.score).toBe(10);
    expect(result.interpretation).toContain('Perfect');
  });

  test('critical findings heavily reduce score', () => {
    const findings = [
      makeFinding({ severity: 'Critical', confidence: 95, title: 'SQL injection', evidence: 'Unsafe query construction' }),
    ];

    const result = calculateReviewScore(findings);
    expect(result.score).toBeLessThanOrEqual(8);
    expect(result.deductions).toBeGreaterThanOrEqual(2);
  });

  test('security findings are penalized more heavily', () => {
    const findings = [
      makeFinding({
        severity: 'High',
        confidence: 90,
        title: 'Security vulnerability',
        evidence: 'OWASP Top 10 A03: Injection vulnerability detected',
      }),
    ];

    const result = calculateReviewScore(findings);
    expect(result.deductions).toBeGreaterThanOrEqual(1.5);
  });

  test('multiple low severity findings accumulate deductions', () => {
    const findings = [
      makeFinding({ severity: 'Low', confidence: 85 }),
      makeFinding({ severity: 'Low', confidence: 80 }),
      makeFinding({ severity: 'Low', confidence: 75 }),
    ];

    const result = calculateReviewScore(findings);
    expect(result.score).toBeLessThan(10);
    expect(result.score).toBeGreaterThan(8);
  });

  test('score stays within 0-10 bounds', () => {
    const findings = [
      makeFinding({ severity: 'Critical', confidence: 100, title: 'SQL injection', evidence: 'Unsafe query' }),
      makeFinding({ severity: 'Critical', confidence: 100, title: 'RCE vulnerability', evidence: 'Command injection' }),
      makeFinding({ severity: 'Critical', confidence: 100, title: 'Auth bypass', evidence: 'Missing auth check' }),
      makeFinding({ severity: 'Critical', confidence: 100, title: 'Data leak', evidence: 'PII exposure' }),
      makeFinding({ severity: 'Critical', confidence: 100, title: 'SSRF', evidence: 'User-controlled URLs' }),
    ];

    const result = calculateReviewScore(findings);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  test('mixed findings produce reasonable score', () => {
    const findings = [
      makeFinding({ severity: 'High', confidence: 90, title: 'Bug in payment flow', evidence: 'Missing validation' }),
      makeFinding({ severity: 'Medium', confidence: 85, title: 'Missing error handling', evidence: 'Async error not caught' }),
      makeFinding({ severity: 'Low', confidence: 80, title: 'Unclear variable name', evidence: 'Use descriptive names' }),
    ];

    const result = calculateReviewScore(findings);
    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.score).toBeLessThanOrEqual(9);
    expect(result.interpretation).toBeTruthy();
  });
});
