/**
 * @module intelligence/technology-detector
 * Deterministic Technology Detection Pipeline.
 *
 * Scans the repository for file extensions, package manifests, and build
 * configuration files to produce a TechnologyProfile without any AI inference.
 *
 * @see 05_REPOSITORY_INTELLIGENCE_PIPELINE.md Section 4.1 for architecture.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { TechnologyProfile } from '../types/index.js';

/**
 * Maps common file extensions to their programming language names.
 * Used for deterministic language proportion calculation.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.dart': 'Dart',
};

/** Directories to skip when scanning for file extensions */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', '.next',
  '__pycache__', '.venv', 'venv', 'target', 'coverage',
]);

/**
 * Recursively collects file extensions from a directory tree,
 * skipping excluded directories like node_modules and .git.
 *
 * @param dir - The directory to scan.
 * @param extensions - Accumulator map of extension → count.
 * @param depth - Current recursion depth (capped at 5 to prevent infinite loops).
 */
function collectExtensions(
  dir: string,
  extensions: Map<string, number>,
  depth: number = 0
): void {
  // Safety: cap recursion depth to prevent massive repo hangs
  // Depth of 12 handles deeply nested Maven/Gradle projects (src/main/java/org/...)
  if (depth > 12) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      collectExtensions(fullPath, extensions, depth + 1);
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (ext && EXTENSION_LANGUAGE_MAP[ext]) {
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      }
    }
  }
}

/**
 * Safely reads and parses a JSON file from the repository.
 *
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed JSON object, or null if the file doesn't exist or is malformed.
 */
function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Detects frameworks from a parsed package.json by checking common dependency names.
 *
 * @param packageJson - The parsed package.json object.
 * @returns An array of detected framework names.
 */
function detectNodeFrameworks(packageJson: Record<string, unknown>): string[] {
  const frameworks: string[] = [];
  const allDeps = {
    ...(packageJson.dependencies as Record<string, string> ?? {}),
    ...(packageJson.devDependencies as Record<string, string> ?? {}),
  };

  // Framework detection rules: dependency name → framework display name
  const frameworkRules: Record<string, string> = {
    'next': 'Next.js',
    'react': 'React',
    'vue': 'Vue.js',
    'svelte': 'Svelte',
    '@angular/core': 'Angular',
    'express': 'Express',
    'fastify': 'Fastify',
    'nestjs': 'NestJS',
    'koa': 'Koa',
    'nuxt': 'Nuxt.js',
    'gatsby': 'Gatsby',
    'remix': 'Remix',
    'astro': 'Astro',
  };

  for (const [dep, name] of Object.entries(frameworkRules)) {
    if (dep in allDeps) {
      frameworks.push(name);
    }
  }

  return frameworks;
}

/**
 * Detects testing libraries from a parsed package.json.
 *
 * @param packageJson - The parsed package.json object.
 * @returns An array of detected testing library names.
 */
function detectTestingLibraries(packageJson: Record<string, unknown>): string[] {
  const libraries: string[] = [];
  const allDeps = {
    ...(packageJson.dependencies as Record<string, string> ?? {}),
    ...(packageJson.devDependencies as Record<string, string> ?? {}),
  };

  const testRules: Record<string, string> = {
    'jest': 'Jest',
    'vitest': 'Vitest',
    'mocha': 'Mocha',
    'cypress': 'Cypress',
    'playwright': 'Playwright',
    '@testing-library/react': 'React Testing Library',
  };

  for (const [dep, name] of Object.entries(testRules)) {
    if (dep in allDeps) {
      libraries.push(name);
    }
  }

  return libraries;
}

/**
 * Detects linters and formatters from a parsed package.json
 * and the presence of configuration files.
 *
 * @param packageJson - The parsed package.json object.
 * @param repoPath - Path to the repository root for config file checks.
 * @returns An array of detected linter/formatter names.
 */
function detectLinters(packageJson: Record<string, unknown>, repoPath: string): string[] {
  const linters: string[] = [];
  const allDeps = {
    ...(packageJson.dependencies as Record<string, string> ?? {}),
    ...(packageJson.devDependencies as Record<string, string> ?? {}),
  };

  if ('eslint' in allDeps || existsSync(join(repoPath, '.eslintrc.json')) || existsSync(join(repoPath, 'eslint.config.js'))) {
    linters.push('ESLint');
  }
  if ('prettier' in allDeps || existsSync(join(repoPath, '.prettierrc'))) {
    linters.push('Prettier');
  }
  if (existsSync(join(repoPath, '.editorconfig'))) {
    linters.push('EditorConfig');
  }

  return linters;
}

/**
 * Scans a repository directory to produce a deterministic TechnologyProfile.
 * Does NOT use any AI inference — relies entirely on file system analysis.
 *
 * @param repoPath - Absolute path to the repository root directory.
 * @returns A TechnologyProfile identifying languages, frameworks, and tooling.
 */
export function detectTechnology(repoPath: string): TechnologyProfile {
  // Step 1: Collect file extensions to determine language proportions
  const extensionCounts = new Map<string, number>();
  collectExtensions(repoPath, extensionCounts);

  // Calculate language percentages from extension counts
  const totalFiles = Array.from(extensionCounts.values()).reduce((sum, c) => sum + c, 0);
  const languageMap = new Map<string, number>();

  for (const [ext, count] of extensionCounts) {
    const lang = EXTENSION_LANGUAGE_MAP[ext];
    if (lang) {
      languageMap.set(lang, (languageMap.get(lang) ?? 0) + count);
    }
  }

  const languages = Array.from(languageMap.entries())
    .map(([name, count]) => ({
      name,
      percentage: totalFiles > 0 ? Math.round((count / totalFiles) * 100) : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage);

  // Step 2: Detect frameworks, testing, and linters from package manifests
  let frameworks: string[] = [];
  let testingLibraries: string[] = [];
  let linters: string[] = [];
  const packageManagers: string[] = [];

  // Node.js ecosystem detection
  const packageJson = safeReadJson(join(repoPath, 'package.json'));
  if (packageJson) {
    frameworks = detectNodeFrameworks(packageJson);
    testingLibraries = detectTestingLibraries(packageJson);
    linters = detectLinters(packageJson, repoPath);

    if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) packageManagers.push('pnpm');
    else if (existsSync(join(repoPath, 'yarn.lock'))) packageManagers.push('yarn');
    else if (existsSync(join(repoPath, 'package-lock.json'))) packageManagers.push('npm');
  }

  // Python ecosystem detection
  if (existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'pyproject.toml'))) {
    if (existsSync(join(repoPath, 'pyproject.toml'))) packageManagers.push('pip/poetry');
  }

  // Go ecosystem detection
  if (existsSync(join(repoPath, 'go.mod'))) {
    packageManagers.push('go modules');
  }

  // Rust ecosystem detection
  if (existsSync(join(repoPath, 'Cargo.toml'))) {
    packageManagers.push('cargo');
  }

  return {
    languages,
    frameworks,
    testingLibraries,
    packageManagers,
    linters,
  };
}
