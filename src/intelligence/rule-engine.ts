/**
 * @module intelligence/rule-engine
 * Deterministic Rule Engine that runs BEFORE any AI inference.
 *
 * Performs fast, regex-based checks against the diff to detect:
 * - Exposed secrets (AWS keys, private keys, JWTs)
 * - Excluded file patterns (lock files, minified code, vendor dirs)
 * - Size limit violations (oversized files or diffs)
 *
 * @see 05_REPOSITORY_INTELLIGENCE_PIPELINE.md Section 4.3 for architecture.
 */

import { execSync } from 'node:child_process';
import type { DiffFile, RuleEngineResult } from '../types/index.js';

/**
 * Regex patterns for detecting leaked secrets in code diffs.
 * Each pattern includes a rule ID and a human-readable description.
 *
 * Business Rule: If ANY secret is detected, the finding is marked
 * as `blocking: true`, which signals the pipeline to halt before
 * sending code to the AI Provider.
 */
const SECRET_PATTERNS: Array<{ ruleId: string; pattern: RegExp; message: string }> = [
  {
    ruleId: 'SEC-001',
    pattern: /AKIA[0-9A-Z]{16}/g,
    message: 'Potential AWS Access Key ID detected',
  },
  {
    ruleId: 'SEC-002',
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/g,
    message: 'Potential AWS Secret Access Key detected',
  },
  {
    ruleId: 'SEC-003',
    pattern: /-----BEGIN\s+(RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/g,
    message: 'Private key detected in diff',
  },
  {
    ruleId: 'SEC-004',
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    message: 'GitHub Personal Access Token detected',
  },
  {
    ruleId: 'SEC-005',
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}/gi,
    message: 'Hardcoded password detected',
  },
  {
    ruleId: 'SEC-006',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    message: 'Potential JWT token detected in source code',
  },
  {
    ruleId: 'SEC-007',
    pattern: /sk-[A-Za-z0-9]{48}/g,
    message: 'Potential OpenAI API key detected',
  },
  {
    ruleId: 'SEC-008',
    pattern: /AIza[A-Za-z0-9_-]{35}/g,
    message: 'Potential Google API key detected',
  },
];

/**
 * File patterns that should be excluded from AI review.
 * These are auto-generated, vendored, or binary files that
 * would waste AI tokens without providing useful feedback.
 */
const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.d\.ts$/,
  /vendor\//,
  /node_modules\//,
  /dist\//,
  /build\//,
  /\.generated\./,
  /\.snap$/,
];

/** Maximum lines per individual file before triggering a size warning */
const MAX_FILE_LINES = 1000;

/** Maximum total diff lines before triggering a size warning */
const MAX_TOTAL_DIFF_LINES = 5000;

/**
 * Scans a diff hunk for secret patterns.
 * Only examines added lines (lines starting with +) to avoid false
 * positives from code that was removed.
 *
 * @param file - The diff file being scanned.
 * @returns An array of RuleEngineResults for detected secrets.
 */
function scanForSecrets(file: DiffFile): RuleEngineResult[] {
  const results: RuleEngineResult[] = [];

  for (const hunk of file.hunks) {
    const addedLines = hunk.content
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'));

    let lineOffset = 0;
    for (const line of addedLines) {
      lineOffset++;
      for (const rule of SECRET_PATTERNS) {
        // Reset regex lastIndex for global patterns
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          results.push({
            ruleId: rule.ruleId,
            message: rule.message,
            filePath: file.filePath,
            lineNumber: hunk.newStart + lineOffset,
            severity: 'critical',
            blocking: true,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Checks if a file matches any excluded file pattern.
 *
 * @param filePath - The relative path of the file.
 * @returns True if the file should be excluded from AI review.
 */
export function isExcludedFile(filePath: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Scans the entire worktree for dangling references to deleted identifiers.
 * Deterministic fallback to catch missing exports/functions.
 */
function scanForDanglingReferences(diffFiles: DiffFile[], worktreePath: string): RuleEngineResult[] {
  const results: RuleEngineResult[] = [];
  const deletedIdentifiers = new Map<string, string>(); // identifier -> origin file

  // 1. Find all deleted identifiers
  for (const file of diffFiles) {
    if (isExcludedFile(file.filePath)) continue;
    
    for (const hunk of file.hunks) {
      const lines = hunk.content.split('\n');
      for (const line of lines) {
        if (line.startsWith('-') && !line.startsWith('---')) {
          const match = line.match(/^-\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
          if (match && match[1]) {
            deletedIdentifiers.set(match[1], file.filePath);
          }
        }
      }
    }
  }

  if (deletedIdentifiers.size === 0) return results;

  // 2. Batch search for all deleted identifiers
  const identifiers = Array.from(deletedIdentifiers.keys());
  const regexPattern = `\\b(${identifiers.join('|')})\\b`;

  try {
    const grepOutput = execSync(`git grep -nE "${regexPattern}"`, { 
      cwd: worktreePath, 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'] 
    });

    const lines = grepOutput.split('\n').filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;

      const [_, filePath, lineNumStr, content] = match;
      if (isExcludedFile(filePath!)) continue;

      const contentTrimmed = content!.trim();
      // False-positive mitigation: ignore re-declarations and imports
      if (/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+/.test(contentTrimmed) || 
          contentTrimmed.startsWith('import ') ||
          contentTrimmed.startsWith('//') ||
          contentTrimmed.startsWith('/*') ||
          contentTrimmed.startsWith('*')) {
        continue;
      }

      for (const id of identifiers) {
        const idRegex = new RegExp(`\\b${id}\\b`);
        if (idRegex.test(contentTrimmed)) {
          const originFile = deletedIdentifiers.get(id);
          results.push({
            ruleId: 'DANG-001',
            message: `Dangling reference: '${id}' was deleted in ${originFile} but is still referenced.`,
            filePath: filePath!,
            lineNumber: parseInt(lineNumStr!, 10),
            severity: 'high',
            blocking: false,
          });
        }
      }
    }
  } catch (err) {
    // git grep exits with 1 if nothing is found
  }

  return results;
}

/**
 * Runs the deterministic Rule Engine against all changed files in the PR diff.
 *
 * This function executes BEFORE any AI inference and produces findings that are:
 * 1. Reported directly as blocking issues (secrets)
 * 2. Passed as additional context to the AI Provider (size warnings, dependency changes)
 *
 * @param diffFiles - The parsed diff files from the GitPlatformAdapter.
 * @returns An object containing all rule engine findings and filtered (reviewable) files.
 */
export function runRuleEngine(diffFiles: DiffFile[], worktreePath?: string): {
  findings: RuleEngineResult[];
  reviewableFiles: DiffFile[];
} {
  const findings: RuleEngineResult[] = [];
  const reviewableFiles: DiffFile[] = [];

  let totalDiffLines = 0;

  for (const file of diffFiles) {
    // Check exclusion list first — skip lock files, vendor, minified, etc.
    if (isExcludedFile(file.filePath)) {
      findings.push({
        ruleId: 'SKIP-001',
        message: `Skipped: File matches exclusion pattern (auto-generated or vendored)`,
        filePath: file.filePath,
        severity: 'low',
        blocking: false,
      });
      continue;
    }

    // Check individual file size
    const fileLines = file.additions + file.deletions;
    totalDiffLines += fileLines;

    if (fileLines > MAX_FILE_LINES) {
      findings.push({
        ruleId: 'SIZE-001',
        message: `Large file change detected: ${fileLines} lines modified. Consider splitting into smaller changes.`,
        filePath: file.filePath,
        severity: 'medium',
        blocking: false,
      });
    }

    // Scan for secrets in added lines
    const secretFindings = scanForSecrets(file);
    findings.push(...secretFindings);

    // Detect dependency manifest changes
    if (/package\.json$|go\.mod$|Cargo\.toml$|requirements\.txt$|pyproject\.toml$/i.test(file.filePath)) {
      findings.push({
        ruleId: 'DEP-001',
        message: 'Dependency manifest changed. Verify new dependencies are reviewed and trusted.',
        filePath: file.filePath,
        severity: 'medium',
        blocking: false,
      });
    }

    // Only include files that aren't excluded in the reviewable set
    reviewableFiles.push(file);
  }

  // Scan for dangling references if worktree path is provided
  if (worktreePath) {
    const danglingFindings = scanForDanglingReferences(diffFiles, worktreePath);
    findings.push(...danglingFindings);
  }

  // Check total diff size
  if (totalDiffLines > MAX_TOTAL_DIFF_LINES) {
    findings.push({
      ruleId: 'SIZE-002',
      message: `Total diff size is ${totalDiffLines} lines, exceeding the ${MAX_TOTAL_DIFF_LINES}-line threshold. Aggressive chunking will be applied.`,
      filePath: 'PR-level',
      severity: 'medium',
      blocking: false,
    });
  }

  return { findings, reviewableFiles };
}
