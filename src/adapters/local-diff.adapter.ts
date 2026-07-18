/**
 * @module adapters/local-diff.adapter
 * A mock GitPlatformAdapter for Phase 1 CLI development.
 *
 * Reads a local unified diff file (`.patch` or `git diff` output) and parses it
 * into the normalized PullRequestEvent and DiffFile structures. This enables
 * end-to-end pipeline testing without any GitHub/GitLab API dependencies.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { GitPlatformAdapter } from './git-platform.adapter.js';
import type { DiffFile, DiffHunk, PullRequestEvent } from '../types/index.js';

/**
 * Parses unified diff text into structured DiffFile objects.
 * Handles standard `git diff` and `diff --git` formats.
 */
function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const lines = block.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch?.[2] ?? 'unknown';

    let changeType: DiffFile['changeType'] = 'modified';
    if (block.includes('new file mode')) changeType = 'added';
    else if (block.includes('deleted file mode')) changeType = 'deleted';
    else if (block.includes('rename from')) changeType = 'renamed';

    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    let currentHunk: DiffHunk | null = null;
    const hunkContentLines: string[] = [];

    for (const line of lines) {
      const hunkHeaderMatch = line.match(/^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@/);
      if (hunkHeaderMatch) {
        if (currentHunk) {
          currentHunk.content = hunkContentLines.join('\n');
          hunks.push(currentHunk);
          hunkContentLines.length = 0;
        }
        currentHunk = {
          oldStart: parseInt(hunkHeaderMatch[1]!, 10),
          oldLines: parseInt(hunkHeaderMatch[2] || '1', 10),
          newStart: parseInt(hunkHeaderMatch[3]!, 10),
          newLines: parseInt(hunkHeaderMatch[4] || '1', 10),
          content: '',
        };
      } else if (currentHunk) {
        hunkContentLines.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
    }

    if (currentHunk) {
      currentHunk.content = hunkContentLines.join('\n');
      hunks.push(currentHunk);
    }

    files.push({ filePath, changeType, hunks, additions, deletions });
  }

  return files;
}

/**
 * Creates a local diff adapter for Phase 1 CLI usage.
 * Reads a `.patch` file from disk and produces normalized PR events and diffs.
 *
 * @param diffPath - Absolute path to the unified diff file.
 * @param repoPath - Absolute path to the repository root (for context file reads).
 * @returns A GitPlatformAdapter for local diffs.
 */
export function createLocalDiffAdapter(
  diffPath: string,
  repoPath: string
): GitPlatformAdapter {
  return {
    parseWebhook(_payload: unknown): PullRequestEvent {
      return {
        platform: 'local',
        repository: {
          id: 'local',
          fullName: basename(repoPath),
          cloneUrl: repoPath,
          defaultBranch: 'main',
        },
        pullRequest: {
          number: 0,
          headSha: 'local-head',
          baseSha: 'local-base',
          title: `Local Review: ${basename(diffPath)}`,
          description: 'Local diff review via CLI',
          author: 'local-user',
        },
        action: 'opened',
      };
    },

    async fetchDiff(_event: PullRequestEvent): Promise<DiffFile[]> {
      const rawDiff = readFileSync(diffPath, 'utf-8');
      return parseUnifiedDiff(rawDiff);
    },

    async postReview(_event: PullRequestEvent, _findings: unknown[]): Promise<void> {
      // In Phase 1 CLI mode, findings are printed to stdout by the formatter.
    },
  };
}
