/**
 * @module adapters/github.adapter
 * Real GitHub GitPlatformAdapter implementation.
 *
 * Uses Octokit to interact with the GitHub API for:
 * - Parsing webhook payloads into normalized PullRequestEvents
 * - Fetching unified diffs for Pull Requests
 * - Posting structured review comments back to the PR
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

/** Maps severity levels to GitHub emoji badges for PR comments. */
const SEVERITY_EMOJI: Record<string, string> = {
  Critical: '🔴',
  High: '🟠',
  Medium: '🟡',
  Low: '🔵',
};

/**
 * Creates an Octokit instance from the given options.
 */
function createOctokit(options: string | GitHubAdapterOptions): { octokit: Octokit; fallbackToken: string } {
  if (typeof options === 'string') {
    const isPlaceholder = !options || options === 'ghp_your_github_token_here';
    return {
      fallbackToken: isPlaceholder ? '' : options,
      octokit: new Octokit({ ...(isPlaceholder ? {} : { auth: options }) }),
    };
  }

  if (options.appId && options.privateKey && options.installationId) {
    return {
      fallbackToken: '',
      octokit: new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: options.appId,
          privateKey: options.privateKey.replace(/\\n/g, '\n'),
          installationId: options.installationId,
        },
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }),
    };
  }

  const token = options.token || '';
  const isPlaceholder = !token || token === 'ghp_your_github_token_here';
  return {
    fallbackToken: isPlaceholder ? '' : token,
    octokit: new Octokit({
      ...(isPlaceholder ? {} : { auth: token }),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    }),
  };
}

/**
 * Creates a GitHub adapter for real PR interactions via the GitHub API.
 * Supports both GitHub.com and GitHub Enterprise Server via configurable base URL.
 *
 * @param options - Authentication and configuration options (string token or GitHubAdapterOptions).
 * @returns A GitPlatformAdapter for GitHub.
 */
export function createGitHubAdapter(options: string | GitHubAdapterOptions): GitPlatformAdapter & { getCloneUrl: (url: string) => Promise<string>; hasAuth: () => boolean } {
  const { octokit, fallbackToken } = createOctokit(options);

  const adapter = {
    async getCloneUrl(cloneUrl: string): Promise<string> {
      try {
        const auth = await octokit.auth({ type: 'installation' }) as { token?: string };
        const token = auth.token || (await octokit.auth({ type: 'get' }) as { token?: string })?.token;
        if (token) {
          return cloneUrl.replace('https://', `https://x-access-token:${token}@`);
        }
      } catch (e) {
        // Ignore auth error and fallback
      }
      return cloneUrl.replace('https://', `https://x-access-token:${fallbackToken}@`);
    },

    hasAuth(): boolean {
      return fallbackToken !== '' || !!(octokit as unknown as { auth: unknown }).auth;
    },

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
    },

    async fetchDiff(event: PullRequestEvent): Promise<DiffFile[]> {
      const [owner, repo] = event.repository.fullName.split('/');
      const response = await octokit.pulls.get({
        owner: owner!,
        repo: repo!,
        pull_number: event.pullRequest.number,
        mediaType: { format: 'diff' },
      });
      const rawDiff = response.data as unknown as string;
      return parseGitDiff(rawDiff);
    },

    async postReview(
      event: PullRequestEvent,
      findings: unknown[],
      metadata?: { summary?: string; risk?: string; suggestedTests?: string[] }
    ): Promise<void> {
      const [owner, repo] = event.repository.fullName.split('/');
      const typedFindings = findings as EnrichedFinding[];

      if (typedFindings.length === 0) {
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

        await octokit.pulls.createReview({
          owner: owner!,
          repo: repo!,
          pull_number: event.pullRequest.number,
          commit_id: event.pullRequest.headSha,
          event: 'COMMENT',
          body: cleanBody,
        });
        return;
      }

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
        return { path: finding.filePath, line: finding.lineNumber, body };
      });

      const criticalCount = typedFindings.filter((f) => f.severity === 'Critical').length;
      const highCount = typedFindings.filter((f) => f.severity === 'High').length;

      const summaryLines = [
        `🤖 **AI PR Reviewer** — Found **${typedFindings.length}** issue(s)`,
        '',
      ];

      if (metadata?.summary) summaryLines.push(`**Summary:**\n\n${metadata.summary}`, '');
      if (metadata?.risk) summaryLines.push(`**Risk:** ${metadata.risk}`, '');
      summaryLines.push(`**Issues Found:**`);
      for (const f of typedFindings) {
        const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪';
        summaryLines.push(`- ${emoji} ${f.title}`);
      }
      summaryLines.push('');
      if (metadata?.suggestedTests?.length) {
        summaryLines.push(`**Suggested Tests:**`);
        for (const test of metadata.suggestedTests) summaryLines.push(`- ${test}`);
        summaryLines.push('');
      }
      summaryLines.push(
        `| Severity | Count |`,
        `|----------|-------|`,
        `| 🔴 Critical | ${criticalCount} |`,
        `| 🟠 High | ${highCount} |`,
        `| 🟡 Medium | ${typedFindings.filter((f) => f.severity === 'Medium').length} |`,
        `| 🔵 Low | ${typedFindings.filter((f) => f.severity === 'Low').length} |`,
      );

      const reviewEvent = criticalCount > 0 ? 'REQUEST_CHANGES' : 'COMMENT';
      await octokit.pulls.createReview({
        owner: owner!,
        repo: repo!,
        pull_number: event.pullRequest.number,
        commit_id: event.pullRequest.headSha,
        event: reviewEvent as 'COMMENT' | 'REQUEST_CHANGES',
        body: summaryLines.join('\n'),
        comments,
      });
    },
  };

  return adapter;
}

/**
 * Parses unified diff text into structured DiffFile objects.
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
