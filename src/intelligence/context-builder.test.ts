import { expect, test, describe } from 'vitest';
import { buildReviewContext } from './context-builder.js';
import type { PullRequestEvent, TechnologyProfile, RuleEngineResult } from '../types/index.js';

describe('Context Builder', () => {
  const mockEvent: PullRequestEvent = {
    platform: 'github',
    repository: {
      id: '12345',
      fullName: 'owner/repo',
      cloneUrl: 'https://github.com/owner/repo.git',
      defaultBranch: 'main',
    },
    pullRequest: {
      number: 42,
      headSha: 'abc123',
      baseSha: 'def456',
      title: 'Fix login bug',
      description: 'This PR fixes a login issue with token expiry.',
      author: 'dev-user',
    },
    action: 'opened',
  };

  const mockTechProfile: TechnologyProfile = {
    languages: [{ name: 'TypeScript', percentage: 80 }, { name: 'JavaScript', percentage: 20 }],
    frameworks: ['Next.js', 'Express'],
    testingLibraries: ['Vitest'],
    packageManagers: ['npm'],
    linters: ['ESLint'],
  };

  const mockRuleFindings: RuleEngineResult[] = [
    {
      ruleId: 'SEC-001',
      message: 'Hardcoded API key detected',
      filePath: 'src/config.ts',
      lineNumber: 15,
      severity: 'high',
      blocking: true,
    },
  ];

  test('builds review context with all fields', () => {
    const context = buildReviewContext(mockEvent, mockTechProfile, mockRuleFindings, 'Use TypeScript strict mode', {
      'src/login.ts': ['src/handler.ts', 'src/router.ts'],
    });

    expect(context.pullRequestMetadata.title).toBe('Fix login bug');
    expect(context.pullRequestMetadata.description).toBe('This PR fixes a login issue with token expiry.');
    expect(context.pullRequestMetadata.author).toBe('dev-user');

    expect(context.technologyStack.languages).toHaveLength(2);
    expect(context.technologyStack.frameworks).toContain('Next.js');

    expect(context.repositoryGuidelines).toBe('Use TypeScript strict mode');

    expect(context.ruleEngineFindings).toHaveLength(1);
    expect(context.ruleEngineFindings[0]!.ruleId).toBe('SEC-001');

    expect(context.blastRadius).toBeDefined();
    expect(context.blastRadius!['src/login.ts']).toContain('src/handler.ts');
  });

  test('handles empty optional fields', () => {
    const context = buildReviewContext(mockEvent, mockTechProfile, [], '', {});

    expect(context.repositoryGuidelines).toBe('');
    expect(context.ruleEngineFindings).toHaveLength(0);
    expect(context.blastRadius).toEqual({});
  });

  test('handles missing blast radius', () => {
    const context = buildReviewContext(mockEvent, mockTechProfile, [], 'guidelines');

    expect(context.blastRadius).toBeUndefined();
  });

  test('preserves technology stack integrity', () => {
    const context = buildReviewContext(mockEvent, mockTechProfile, [], '');

    expect(context.technologyStack).toEqual(mockTechProfile);
    expect(context.technologyStack.languages[0]!.percentage).toBe(80);
    expect(context.technologyStack.testingLibraries).toContain('Vitest');
    expect(context.technologyStack.linters).toContain('ESLint');
    expect(context.technologyStack.packageManagers).toContain('npm');
  });
});
