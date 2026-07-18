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
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** Default directory for storing bare repository caches */
const DEFAULT_CACHE_DIR = join(process.cwd(), '.repo-cache');

/**
 * Creates a repository cache manager that maintains persistent bare git
 * repositories on disk and uses `git worktree` to create lightweight,
 * temporary checkouts for each PR review.
 *
 * @param cacheDir - Directory to store bare git repos (default: .repo-cache/).
 * @returns An object with ensureRepository, createWorktree, removeWorktree, deleteRepository methods.
 */
export function createRepositoryCache(cacheDir: string = DEFAULT_CACHE_DIR) {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const activeLocks = new Map<string, Promise<string>>();

  /**
   * Performs a bare clone of a repository into the cache directory.
   */
  async function cloneBare(targetPath: string, cloneUrl: string): Promise<void> {
    await execAsync(`git clone --bare "${cloneUrl}" "${targetPath}"`, {
      timeout: 3_600_000,
    });
  }

  async function removeWorktreeInternal(bareRepoPath: string, worktreePath: string): Promise<void> {
    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, {
        cwd: bareRepoPath,
        timeout: 30_000,
      });
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        await execAsync('git worktree prune', {
          cwd: bareRepoPath,
          timeout: 10_000,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  async function ensureRepositoryInternal(repoId: string, cloneUrl: string): Promise<string> {
    const bareRepoPath = join(cacheDir, repoId);

    if (existsSync(bareRepoPath)) {
      try {
        await execAsync('git fetch origin --prune', {
          cwd: bareRepoPath,
          timeout: 120_000,
        });
      } catch (error) {
        console.warn(`[RepoCache] Fetch failed for ${repoId}, re-cloning...`);
        rmSync(bareRepoPath, { recursive: true, force: true });
        await cloneBare(bareRepoPath, cloneUrl);
      }
    } else {
      await cloneBare(bareRepoPath, cloneUrl);
    }

    return bareRepoPath;
  }

  return {
    /**
     * Ensures a repository is available in the cache.
     * Performs a bare clone on cache miss or a fetch on cache hit.
     */
    async ensureRepository(repoId: string, cloneUrl: string): Promise<string> {
      if (activeLocks.has(repoId)) {
        return activeLocks.get(repoId)!;
      }

      const promise = ensureRepositoryInternal(repoId, cloneUrl).finally(() => {
        activeLocks.delete(repoId);
      });

      activeLocks.set(repoId, promise);
      return promise;
    },

    /**
     * Creates a temporary git worktree for a specific PR commit.
     */
    async createWorktree(
      bareRepoPath: string,
      headSha: string,
      prNumber: number
    ): Promise<string> {
      const worktreePath = join(cacheDir, `worktree-pr-${prNumber}-${headSha.slice(0, 8)}`);

      if (existsSync(worktreePath)) {
        await removeWorktreeInternal(bareRepoPath, worktreePath);
      }

      try {
        await execAsync(`git fetch origin ${headSha}`, {
          cwd: bareRepoPath,
          timeout: 60_000,
        });
      } catch {
        await execAsync('git fetch origin', {
          cwd: bareRepoPath,
          timeout: 120_000,
        });
      }

      await execAsync(`git worktree add "${worktreePath}" ${headSha}`, {
        cwd: bareRepoPath,
        timeout: 60_000,
      });

      return worktreePath;
    },

    /**
     * Removes a worktree after the review is complete.
     */
    async removeWorktree(bareRepoPath: string, worktreePath: string): Promise<void> {
      return removeWorktreeInternal(bareRepoPath, worktreePath);
    },

    /**
     * Deletes a cached repository completely from disk.
     */
    async deleteRepository(repoId: string): Promise<boolean> {
      const bareRepoPath = join(cacheDir, repoId);
      if (existsSync(bareRepoPath)) {
        rmSync(bareRepoPath, { recursive: true, force: true });
        return true;
      }
      return false;
    },
  };
}

export type RepositoryCache = ReturnType<typeof createRepositoryCache>;
