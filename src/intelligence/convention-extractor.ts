/**
 * @module intelligence/convention-extractor
 * Automated Repository Convention Extraction.
 *
 * Scans the repository root for standard documentation and configuration files
 * that describe coding conventions. These are concatenated and truncated
 * to feed as additional context to the AI Provider.
 *
 * @see 05_REPOSITORY_INTELLIGENCE_PIPELINE.md Section 4.4 for architecture.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../db/prisma.js';

/**
 * The ordered list of convention files to search for.
 * Files are listed in priority order — AI-specific instructions first,
 * then general project documentation.
 */
const CONVENTION_FILES = [
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
  '.cursorrules',
  'CONTRIBUTING.md',
  'README.md',
  '.editorconfig',
  '.github/CONTRIBUTING.md',
  '.gitlab/CONTRIBUTING.md',
];

/**
 * Maximum character count for the concatenated guidelines block.
 * Approximately ~2000 tokens assuming ~4 chars per token.
 * Prevents the context payload from overwhelming the AI context window.
 */
const MAX_GUIDELINES_CHARS = 8000;

/**
 * Extracts repository conventions by scanning for standard documentation files.
 * Files are concatenated with clear section headers so the AI can distinguish
 * between different sources of guidelines.
 *
 * Business Rule: If the total extracted text exceeds MAX_GUIDELINES_CHARS,
 * it is truncated with a warning message appended. This prevents context
 * window exhaustion while still providing the most important guidelines
 * (AI-specific files are prioritized via the file ordering).
 *
 * @param repoPath - Absolute path to the repository root directory.
 * @param repositoryId - Optional repository ID to fetch rejected findings from the database.
 * @returns A concatenated string of repository guidelines, or an empty string if none found.
 */
export async function extractConventions(repoPath: string, repositoryId?: string): Promise<string> {
  const sections: string[] = [];
  let totalLength = 0;

  for (const fileName of CONVENTION_FILES) {
    const filePath = join(repoPath, fileName);

    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8').trim();
    } catch {
      // Skip files that can't be read (e.g., permission errors)
      continue;
    }

    if (!content) continue;

    // Build the section header for clear attribution in the AI context
    const section = `\n--- ${fileName} ---\n${content}\n`;

    // Check if adding this section would exceed the limit
    if (totalLength + section.length > MAX_GUIDELINES_CHARS) {
      // Include a truncated version of this file to fill remaining space
      const remaining = MAX_GUIDELINES_CHARS - totalLength;
      if (remaining > 200) {
        const truncatedContent = content.substring(0, remaining - 100);
        sections.push(`\n--- ${fileName} (truncated) ---\n${truncatedContent}\n...[truncated]`);
      }
      sections.push('\n[Guidelines truncated to fit context window]');
      break;
    }

    sections.push(section);
    totalLength += section.length;
  }

  // Fetch rejected findings from the database to learn from past mistakes
  if (repositoryId && totalLength < MAX_GUIDELINES_CHARS) {
    try {
      const rejectedFindings = await prisma.reviewFinding.findMany({
        where: {
          pullRequest: { repositoryId },
          status: 'REJECTED',
        },
        orderBy: { createdAt: 'desc' },
        take: 20, // Only take the latest 20 to avoid blowing up the context
      });

      if (rejectedFindings.length > 0) {
        let feedbackSection = '\n--- PAST MISTAKES TO AVOID (From Developer Feedback) ---\n';
        feedbackSection += 'Do NOT make these suggestions in the future, as developers have explicitly rejected them:\n';
        for (const finding of rejectedFindings) {
          if (finding.feedbackReason) {
            feedbackSection += `- You previously suggested: "${finding.title}". Developer rejected this because: "${finding.feedbackReason}"\n`;
          }
        }
        
        if (totalLength + feedbackSection.length <= MAX_GUIDELINES_CHARS) {
          sections.push(feedbackSection);
          totalLength += feedbackSection.length;
        }
      }
    } catch (err) {
      // Ignore db errors
    }
  }

  return sections.join('\n').trim();
}
