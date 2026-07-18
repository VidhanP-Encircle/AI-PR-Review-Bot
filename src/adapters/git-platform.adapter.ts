/**
 * @module adapters/git-platform.adapter
 * Defines the abstract interface for all Git platform integrations.
 *
 * This abstraction ensures the core review engine remains completely
 * ignorant of whether a webhook originated from GitHub, GitLab, or a local diff.
 *
 * @see 06_GIT_INTEGRATION_AND_WEBHOOKS.md for architectural context.
 */

import type { DiffFile, PullRequestEvent } from '../types/index.js';

/**
 * Abstract interface that all Git platform adapters must implement.
 * Provides a vendor-agnostic contract for webhook parsing, diff fetching,
 * and review publishing.
 */
export interface GitPlatformAdapter {
  /**
   * Parses a raw webhook payload into a normalized PullRequestEvent.
   *
   * @param payload - The raw webhook body from the Git platform.
   * @returns A normalized PullRequestEvent stripped of vendor-specific fields.
   */
  parseWebhook(payload: unknown): PullRequestEvent;

  /**
   * Fetches the unified diff for a given Pull Request.
   *
   * @param event - The normalized PR event containing repository and PR metadata.
   * @returns An array of parsed DiffFile objects representing all changed files.
   */
  fetchDiff(event: PullRequestEvent): Promise<DiffFile[]>;

  /**
   * Posts the final review findings back to the Pull Request as comments.
   *
   * @param event - The normalized PR event identifying the target PR.
   * @param findings - The array of enriched findings to publish.
   */
  postReview(event: PullRequestEvent, findings: unknown[]): Promise<void>;
}
