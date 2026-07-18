/**
 * @module cache/repository-cache
 * Incremental Repository Cache Manager.
 *
 * Maintains persistent bare git repositories on disk and uses `git worktree`
 * to create lightweight, temporary checkouts for each PR review. This
 * eliminates the expensive clone-delete cycle for every webhook.
 *
 * Cache Flow:
 * 1. Cache Miss → `git clone --bare` (first time)
 * 2. Cache Hit → `git fetch origin` (only new commits)
 * 3. PR Review → `git worktree add` (instant, lightweight)
 * 4. Cleanup → `git worktree remove` (bare repo persists)
 *
 * @see 06_GIT_INTEGRATION_AND_WEBHOOKS.md Section 4.2 for architecture.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** Default directory for storing bare repository caches */
const DEFAULT_CACHE_DIR = join(process.cwd(), '.repo-cache');

/**
 * Manages the lifecycle of cached bare repositories and worktrees.
 *
 * Business Rule: The cache directory persists across server restarts.
 * Bare repos are never deleted automatically — only worktrees are
 * cleaned up after each review completes.
 */
export class RepositoryCache {
  private readonly cacheDir: string;
  private activeLocks: Map<string, Promise<string>> = new Map();

  /**
   * @param cacheDir - Directory to store bare git repos (default: .repo-cache/).
   */
  constructor(cacheDir: string = DEFAULT_CACHE_DIR) {
    this.cacheDir = cacheDir;
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Ensures a repository is available in the cache.
   * Performs a bare clone on cache miss or a fetch on cache hit.
   *
   * @param repoId - Unique identifier for the repository (e.g., GitHub repo ID).
   * @param cloneUrl - The HTTPS clone URL (with token embedded for private repos).
   * @returns The absolute path to the bare repository in the cache.
   */
  async ensureRepository(repoId: string, cloneUrl: string): Promise<string> {
    if (this.activeLocks.has(repoId)) {
      return this.activeLocks.get(repoId)!;
    }

    const promise = this._ensureRepositoryInternal(repoId, cloneUrl).finally(() => {
      this.activeLocks.delete(repoId);
    });

    this.activeLocks.set(repoId, promise);
    return promise;
  }

  private async _ensureRepositoryInternal(repoId: string, cloneUrl: string): Promise<string> {
    const bareRepoPath = join(this.cacheDir, repoId);

    if (existsSync(bareRepoPath)) {
      // Cache hit: fetch latest changes
      try {
        await execAsync('git fetch origin --prune', {
          cwd: bareRepoPath,
          timeout: 120_000, // 2 minute timeout
        });
      } catch (error) {
        // If fetch fails, remove the cache and re-clone
        console.warn(`[RepoCache] Fetch failed for ${repoId}, re-cloning...`);
        rmSync(bareRepoPath, { recursive: true, force: true });
        await this.cloneBare(bareRepoPath, cloneUrl);
      }
    } else {
      // Cache miss: bare clone
      await this.cloneBare(bareRepoPath, cloneUrl);
    }

    return bareRepoPath;
  }

  /**
   * Creates a temporary git worktree for a specific PR commit.
   * Worktrees are instant lightweight checkouts from the bare repo.
   *
   * @param bareRepoPath - Path to the bare repository.
   * @param headSha - The commit SHA to checkout in the worktree.
   * @param prNumber - The PR number (used to create a unique worktree name).
   * @returns The absolute path to the worktree directory.
   */
  async createWorktree(
    bareRepoPath: string,
    headSha: string,
    prNumber: number
  ): Promise<string> {
    const worktreePath = join(this.cacheDir, `worktree-pr-${prNumber}-${headSha.slice(0, 8)}`);

    // Remove existing worktree if it exists (stale from a previous review)
    if (existsSync(worktreePath)) {
      this.removeWorktree(bareRepoPath, worktreePath);
    }

    try {
      // Fetch the specific commit first to ensure it's available
      await execAsync(`git fetch origin ${headSha}`, {
        cwd: bareRepoPath,
        timeout: 60_000,
      });
    } catch {
      // If fetching a specific SHA fails, try fetching all
      await execAsync('git fetch origin', {
        cwd: bareRepoPath,
        timeout: 120_000,
      });
    }

    // Create the worktree at the exact commit
    await execAsync(`git worktree add "${worktreePath}" ${headSha}`, {
      cwd: bareRepoPath,
      timeout: 60_000,
    });

    return worktreePath;
  }

  /**
   * Removes a worktree after the review is complete.
   * The bare repository remains cached for future reviews.
   *
   * @param bareRepoPath - Path to the bare repository.
   * @param worktreePath - Path to the worktree to remove.
   */
  async removeWorktree(bareRepoPath: string, worktreePath: string): Promise<void> {
    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, {
        cwd: bareRepoPath,
        timeout: 30_000,
      });
    } catch {
      // If git worktree remove fails, just delete the directory
      rmSync(worktreePath, { recursive: true, force: true });
      // Prune stale worktree references
      try {
        await execAsync('git worktree prune', {
          cwd: bareRepoPath,
          timeout: 10_000,
        });
      } catch {
        // Non-fatal — log and continue
      }
    }
  }

  /**
   * Performs a bare clone of a repository into the cache directory.
   *
   * @param targetPath - Where to clone the bare repo.
   * @param cloneUrl - The HTTPS clone URL.
   */
  private async cloneBare(targetPath: string, cloneUrl: string): Promise<void> {
    await execAsync(`git clone --bare "${cloneUrl}" "${targetPath}"`, {
      timeout: 3_600_000, // 1 hour timeout for extremely large repos (like open-design which is 1.5GB+)
    });
  }

  /**
   * Deletes a cached repository completely from disk.
   *
   * @param repoId - Unique identifier for the repository (e.g., github full name formatted).
   * @returns true if deleted, false if it didn't exist.
   */
  async deleteRepository(repoId: string): Promise<boolean> {
    const bareRepoPath = join(this.cacheDir, repoId);
    if (existsSync(bareRepoPath)) {
      rmSync(bareRepoPath, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}
