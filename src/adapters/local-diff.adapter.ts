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
 *
 * @param diffText - Raw unified diff content.
 * @returns An array of DiffFile objects representing all changed files.
 */
function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];

  // Split the diff into per-file blocks using the "diff --git" header
  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const lines = block.split('\n');

    // Extract file path from the "diff --git a/path b/path" header
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch?.[2] ?? 'unknown';

    // Determine change type from diff metadata lines
    let changeType: DiffFile['changeType'] = 'modified';
    if (block.includes('new file mode')) {
      changeType = 'added';
    } else if (block.includes('deleted file mode')) {
      changeType = 'deleted';
    } else if (block.includes('rename from')) {
      changeType = 'renamed';
    }

    // Parse individual hunks from @@ markers
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    let currentHunk: DiffHunk | null = null;
    const hunkContentLines: string[] = [];

    for (const line of lines) {
      const hunkHeaderMatch = line.match(/^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@/);

      if (hunkHeaderMatch) {
        // Flush the previous hunk if it exists
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
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      }
    }

    // Flush the last hunk
    if (currentHunk) {
      currentHunk.content = hunkContentLines.join('\n');
      hunks.push(currentHunk);
    }

    files.push({ filePath, changeType, hunks, additions, deletions });
  }

  return files;
}

/**
 * Local diff adapter for Phase 1 CLI usage.
 * Reads a `.patch` file from disk and produces normalized PR events and diffs.
 *
 * @implements {GitPlatformAdapter}
 */
export class LocalDiffAdapter implements GitPlatformAdapter {
  private readonly diffPath: string;
  private readonly repoPath: string;

  /**
   * @param diffPath - Absolute path to the unified diff file.
   * @param repoPath - Absolute path to the repository root (for context file reads).
   */
  constructor(diffPath: string, repoPath: string) {
    this.diffPath = diffPath;
    this.repoPath = repoPath;
  }

  /**
   * Creates a synthetic PullRequestEvent from local file metadata.
   * Since there is no real webhook, we generate a placeholder event.
   *
   * @param _payload - Ignored for local adapter.
   * @returns A synthetic PullRequestEvent.
   */
  parseWebhook(_payload: unknown): PullRequestEvent {
    return {
      platform: 'local',
      repository: {
        id: 'local',
        fullName: basename(this.repoPath),
        cloneUrl: this.repoPath,
        defaultBranch: 'main',
      },
      pullRequest: {
        number: 0,
        headSha: 'local-head',
        baseSha: 'local-base',
        title: `Local Review: ${basename(this.diffPath)}`,
        description: 'Local diff review via CLI',
        author: 'local-user',
      },
      action: 'opened',
    };
  }

  /**
   * Reads and parses the local diff file into structured DiffFile objects.
   *
   * @param _event - The PR event (unused for local reads).
   * @returns An array of parsed DiffFile objects.
   */
  async fetchDiff(_event: PullRequestEvent): Promise<DiffFile[]> {
    const rawDiff = readFileSync(this.diffPath, 'utf-8');
    return parseUnifiedDiff(rawDiff);
  }

  /**
   * No-op for local adapter. Findings are printed to console instead.
   *
   * @param _event - Ignored.
   * @param _findings - Ignored.
   */
  async postReview(_event: PullRequestEvent, _findings: unknown[]): Promise<void> {
    // In Phase 1 CLI mode, findings are printed to stdout by the formatter.
  }
}
