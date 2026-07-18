/**
 * @module adapters/github.adapter
 * Real GitHub GitPlatformAdapter implementation.
 *
 * Uses Octokit to interact with the GitHub API for:
 * - Parsing webhook payloads into normalized PullRequestEvents
 * - Fetching unified diffs for Pull Requests
 * - Posting structured review comments back to the PR
 *
 * @see 06_GIT_INTEGRATION_AND_WEBHOOKS.md for architectural context.
 */

import { Octokit } from '@octokit/rest';
import type { GitPlatformAdapter } from './git-platform.adapter.js';
import type { DiffFile, DiffHunk, PullRequestEvent, EnrichedFinding } from '../types/index.js';
import { isVulnerabilityCitation, getUnverifiedLabel } from '../pipeline/cve-utils.js';

import { createAppAuth } from '@octokit/auth-app';

export interface GitHubAdapterOptions {
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: string;
  baseUrl?: string;
}

/**
 * Maps severity levels to GitHub emoji badges for PR comments.
 */
const SEVERITY_EMOJI: Record<string, string> = {
  Critical: '🔴',
  High: '🟠',
  Medium: '🟡',
  Low: '🔵',
};

/**
 * GitHub adapter for real PR interactions via the GitHub API.
 * Supports both GitHub.com and GitHub Enterprise Server via configurable base URL.
 *
 * @implements {GitPlatformAdapter}
 */
export class GitHubAdapter implements GitPlatformAdapter {
  private readonly octokit: Octokit;
  private readonly fallbackToken: string;

  /**
   * @param options - Authentication and configuration options
   */
  constructor(options: string | GitHubAdapterOptions) {
    if (typeof options === 'string') {
      const isPlaceholder = !options || options === 'ghp_your_github_token_here';
      this.fallbackToken = isPlaceholder ? '' : options;
      this.octokit = new Octokit({
        ...(isPlaceholder ? {} : { auth: options }),
      });
    } else if (options.appId && options.privateKey && options.installationId) {
      this.fallbackToken = '';
      this.octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: options.appId,
          privateKey: options.privateKey.replace(/\\n/g, '\n'),
          installationId: options.installationId,
        },
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      });
    } else {
      const token = options.token || '';
      const isPlaceholder = !token || token === 'ghp_your_github_token_here';
      this.fallbackToken = isPlaceholder ? '' : token;
      this.octokit = new Octokit({
        ...(isPlaceholder ? {} : { auth: token }),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      });
    }
  }

  /**
   * Retrieves an authenticated clone URL.
   * If using a GitHub App, it generates a fresh installation token.
   * If using a PAT, it injects the PAT.
   *
   * @param cloneUrl - The base clone URL (e.g., https://github.com/owner/repo.git)
   * @returns The authenticated clone URL.
   */
  async getCloneUrl(cloneUrl: string): Promise<string> {
    try {
      const auth = await this.octokit.auth({ type: 'installation' }) as { token?: string };
      const token = auth.token || (await this.octokit.auth({ type: 'get' }) as { token?: string })?.token;
      
      if (token) {
        return cloneUrl.replace('https://', `https://x-access-token:${token}@`);
      }
    } catch (e) {
      // Ignore auth error and fallback
    }

    return cloneUrl.replace('https://', `https://x-access-token:${this.fallbackToken}@`);
  }

  /**
   * Checks if the adapter has valid authentication configured.
   */
  hasAuth(): boolean {
    return this.fallbackToken !== '' || !!(this.octokit as unknown as { auth: unknown }).auth;
  }

  /**
   * Parses a raw GitHub webhook payload into a normalized PullRequestEvent.
   * Handles `pull_request` event types with actions: opened, synchronize, reopened.
   *
   * @param payload - The raw GitHub webhook JSON body.
   * @returns A normalized PullRequestEvent.
   * @throws Error if the payload is not a recognized PR event.
   */
  parseWebhook(payload: unknown): PullRequestEvent {
    const data = payload as {
      action?: string;
      pull_request?: {
        number: number;
        head?: { sha: string };
        base?: { sha: string };
        title?: string;
        body?: string;
        user?: { login: string };
      };
      repository?: {
        id: number;
        full_name?: string;
        clone_url?: string;
        default_branch?: string;
      };
    };

    if (!data.pull_request || !data.repository) {
      throw new Error('Invalid GitHub webhook payload: missing pull_request or repository');
    }

    const actionMap: Record<string, PullRequestEvent['action']> = {
      opened: 'opened',
      synchronize: 'synchronize',
      reopened: 'reopened',
    };

    const action = actionMap[data.action ?? ''];
    if (!action) {
      throw new Error(`Unsupported GitHub PR action: "${data.action}"`);
    }

    return {
      platform: 'github',
      repository: {
        id: String(data.repository.id),
        fullName: data.repository.full_name ?? '',
        cloneUrl: data.repository.clone_url ?? '',
        defaultBranch: data.repository.default_branch ?? 'main',
      },
      pullRequest: {
        number: data.pull_request.number,
        headSha: data.pull_request.head?.sha ?? '',
        baseSha: data.pull_request.base?.sha ?? '',
        title: data.pull_request.title ?? '',
        description: data.pull_request.body ?? '',
        author: data.pull_request.user?.login ?? '',
      },
      action,
    };
  }

  /**
   * Fetches the unified diff for a Pull Request from the GitHub API.
   * Uses the `application/vnd.github.v3.diff` media type to get raw diff text,
   * then parses it into structured DiffFile objects.
   *
   * @param event - The normalized PR event.
   * @returns An array of parsed DiffFile objects.
   */
  async fetchDiff(event: PullRequestEvent): Promise<DiffFile[]> {
    const [owner, repo] = event.repository.fullName.split('/');

    // Fetch raw diff using GitHub's diff media type
    const response = await this.octokit.pulls.get({
      owner: owner!,
      repo: repo!,
      pull_number: event.pullRequest.number,
      mediaType: { format: 'diff' },
    });

    // The response.data is the raw diff string when using diff format
    const rawDiff = response.data as unknown as string;
    return parseGitDiff(rawDiff);
  }

  /**
   * Posts review findings as a PR review with inline comments.
   * Creates a single review with line-level comments for each finding,
   * plus a summary comment with overall statistics in MVP format.
   *
   * @param event - The normalized PR event.
   * @param findings - The enriched findings array to publish.
   * @param metadata - Optional PR-level metadata (summary, risk, suggestedTests).
   */
  async postReview(
    event: PullRequestEvent,
    findings: unknown[],
    metadata?: { summary?: string; risk?: string; suggestedTests?: string[] }
  ): Promise<void> {
    const [owner, repo] = event.repository.fullName.split('/');
    const typedFindings = findings as EnrichedFinding[];

    if (typedFindings.length === 0) {
      // Post a simple approval comment if no issues found
      const cleanBody = [
        '✅ **AI PR Reviewer** — Review complete. No actionable issues were found.',
        '',
        metadata?.summary ? `**Summary:**\n\n${metadata.summary}` : '',
        '',
        metadata?.risk ? `**Risk:** ${metadata.risk}` : '',
        '',
        metadata?.suggestedTests?.length
          ? `**Suggested Tests:**\n${metadata.suggestedTests.map(t => `- ${t}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');

      await this.octokit.pulls.createReview({
        owner: owner!,
        repo: repo!,
        pull_number: event.pullRequest.number,
        commit_id: event.pullRequest.headSha,
        event: 'COMMENT',
        body: cleanBody,
      });
      return;
    }

    // Build inline review comments from the findings
    const comments = typedFindings.map((finding) => {
      const emoji = SEVERITY_EMOJI[finding.severity] ?? '⚪';
      let body = `${emoji} **${finding.severity}** — ${finding.title}\n\n`;
      
      if (isVulnerabilityCitation(finding.title, finding.evidence)) {
        body += `**Confidence:** ${getUnverifiedLabel()}\n\n`;
      } else {
        body += `**Confidence:** ${finding.confidence}%\n\n`;
      }
      
      body += `**Evidence:** ${finding.evidence}\n\n`;
      body += `**Recommendation:** ${finding.recommendation}\n`;

      if (finding.suggestedFix) {
        body += `\n**Suggested Fix:**\n\`\`\`suggestion\n${finding.suggestedFix}\n\`\`\``;
      }

      body += `\n\n---\n*(Reply **"Reject: [reason]"** to teach me for next time).*`;

      return {
        path: finding.filePath,
        line: finding.lineNumber,
        body,
      };
    });

    // Build MVP-style summary body
    const criticalCount = typedFindings.filter((f) => f.severity === 'Critical').length;
    const highCount = typedFindings.filter((f) => f.severity === 'High').length;

    const summaryLines = [
      `🤖 **AI PR Reviewer** — Found **${typedFindings.length}** issue(s)`,
      '',
    ];

    // Summary section
    if (metadata?.summary) {
      summaryLines.push(`**Summary:**\n\n${metadata.summary}`, '');
    }

    // Risk section
    if (metadata?.risk) {
      summaryLines.push(`**Risk:** ${metadata.risk}`, '');
    }

    // Issues Found section
    summaryLines.push(`**Issues Found:**`);
    for (const f of typedFindings) {
      const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪';
      summaryLines.push(`- ${emoji} ${f.title}`);
    }
    summaryLines.push('');

    // Suggested Tests section
    if (metadata?.suggestedTests?.length) {
      summaryLines.push(`**Suggested Tests:**`);
      for (const test of metadata.suggestedTests) {
        summaryLines.push(`- ${test}`);
      }
      summaryLines.push('');
    }

    // Severity breakdown table
    summaryLines.push(
      `| Severity | Count |`,
      `|----------|-------|`,
      `| 🔴 Critical | ${criticalCount} |`,
      `| 🟠 High | ${highCount} |`,
      `| 🟡 Medium | ${typedFindings.filter((f) => f.severity === 'Medium').length} |`,
      `| 🔵 Low | ${typedFindings.filter((f) => f.severity === 'Low').length} |`,
    );

    const summaryBody = summaryLines.join('\n');

    // Determine review event type based on severity
    const reviewEvent = criticalCount > 0 ? 'REQUEST_CHANGES' : 'COMMENT';

    await this.octokit.pulls.createReview({
      owner: owner!,
      repo: repo!,
      pull_number: event.pullRequest.number,
      commit_id: event.pullRequest.headSha,
      event: reviewEvent as 'COMMENT' | 'REQUEST_CHANGES',
      body: summaryBody,
      comments,
    });
  }

}

/**
 * Parses unified diff text into structured DiffFile objects.
 * Reuses the same parsing logic as the LocalDiffAdapter.
 *
 * @param diffText - Raw unified diff content.
 * @returns An array of DiffFile objects.
 */
export function parseGitDiff(diffText: string): DiffFile[] {
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
