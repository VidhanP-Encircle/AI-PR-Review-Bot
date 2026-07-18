import { expect, test, describe, vi, beforeEach } from 'vitest';
import { detectTechnology } from './technology-detector.js';
import fs from 'node:fs';

vi.mock('node:fs');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Technology Detector', () => {
  test('detects JavaScript and TypeScript from package.json with source files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation((path: any) => {
      const p = path.toString();
      if (p === '/fake/repo') return ['src', 'package.json'] as any;
      if (p === '/fake/repo/src') return ['index.ts', 'app.tsx'] as any;
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation((path: any) => {
      const p = path.toString();
      return {
        isDirectory: () => p.endsWith('/src') || p === '/fake/repo',
        isFile: () => p.includes('.') && !p.endsWith('/src') && p !== '/fake/repo',
      } as fs.Stats;
    });

    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (path.toString().includes('package.json')) {
        return JSON.stringify({
          dependencies: { react: '^18.0.0', express: '^4.0.0' }
        });
      }
      if (path.toString().includes('.ts')) return 'const x = 1;';
      return '';
    });

    const result = detectTechnology('/fake/repo');
    expect(result.languages.length).toBeGreaterThan(0);
    expect(result.languages.some((l) => l.name === 'TypeScript')).toBe(true);
    expect(result.frameworks).toContain('React');
    expect(result.frameworks).toContain('Express');
  });

  test('detects Python from requirements.txt with .py source files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation((path: any) => {
      const p = path.toString();
      if (p === '/fake/repo') return ['src', 'requirements.txt'] as any;
      if (p === '/fake/repo/src') return ['main.py', 'utils.py'] as any;
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation((path: any) => {
      const p = path.toString();
      return {
        isDirectory: () => p.endsWith('/src') || p === '/fake/repo',
        isFile: () => p.includes('.') && !p.endsWith('/src') && p !== '/fake/repo',
      } as fs.Stats;
    });
    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (path.toString().includes('requirements.txt')) return 'flask==2.0.0\nnumpy==1.21.0';
      if (path.toString().includes('.py')) return 'import flask';
      return '';
    });

    const result = detectTechnology('/fake/repo');
    expect(result.languages.some((l) => l.name === 'Python')).toBe(true);
  });

  test('detects Go from go.mod', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['main.go', 'go.mod'] as any);
    vi.mocked(fs.statSync).mockImplementation((path: any) => {
      const p = path.toString();
      return {
        isDirectory: () => !p.includes('.'),
        isFile: () => p.includes('.'),
      } as fs.Stats;
    });
    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (path.toString().includes('go.mod')) return 'module github.com/user/repo\ngo 1.21';
      if (path.toString().includes('.go')) return 'package main';
      return '';
    });

    const result = detectTechnology('/fake/repo');
    expect(result.languages.some((l) => l.name === 'Go')).toBe(true);
  });

  test('returns empty profile for empty/unknown repo', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['README.md', '.gitignore'] as any);
    vi.mocked(fs.statSync).mockImplementation((path: any) => {
      const p = path.toString();
      return {
        isDirectory: () => !p.includes('.'),
        isFile: () => p.includes('.'),
      } as fs.Stats;
    });

    const result = detectTechnology('/fake/repo');
    expect(result.languages.length).toBe(0);
    expect(result.frameworks.length).toBe(0);
  });
});
