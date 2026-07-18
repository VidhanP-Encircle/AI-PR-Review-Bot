import { expect, test, describe, vi, beforeEach } from 'vitest';
import { extractConventions } from './convention-extractor.js';
import fs from 'node:fs';

vi.mock('node:fs');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Convention Extractor', () => {
  test('extracts conventions from CONTRIBUTING.md', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      const p = path.toString();
      return p.includes('CONTRIBUTING.md') || p.includes('contributing');
    });
    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (path.toString().includes('CONTRIBUTING.md')) {
        return '# Contributing\n## Code Style\nUse Prettier with 2-space indent.\n## Tests\nRun `npm test` before submitting.';
      }
      return '';
    });

    const conventions = await extractConventions('/fake/repo');
    expect(conventions).toContain('Code Style');
    expect(conventions).toContain('Prettier');
    expect(conventions).toContain('test');
  });

  test('returns empty string when no guidelines found', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    const conventions = await extractConventions('/fake/empty-repo');
    expect(conventions).toBe('');
  });

  test('reads .cursorrules file', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      const p = path.toString();
      return p.includes('.cursorrules') || p.includes('CLAUDE.md');
    });
    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (path.toString().includes('.cursorrules')) {
        return 'Always use named exports.';
      }
      return '';
    });

    const conventions = await extractConventions('/fake/repo');
    expect(conventions).toContain('named exports');
  });
});
