/**
 * @module chunking/chunking-engine
 * Chunking Engine — Maps PR diff lines to AST structural blocks.
 *
 * Implements Round 1 of the 3-Round Chunking Strategy:
 * 1. Intersects changed line numbers from the diff with AST nodes.
 * 2. Extracts the smallest enclosing structural block (function/class).
 * 3. Enriches each chunk with surrounding imports and type declarations.
 *
 * @see 07_CHUNKED_ANALYSIS_AND_TREE_SITTER.md for architecture.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodeChunk, DiffFile } from '../types/index.js';
import { parseAndExtractNodes, extractImports } from './tree-sitter-parser.js';

/**
 * Maximum lines for a single chunk before sub-splitting is triggered.
 * Prevents sending excessively large God Classes to the AI in one request.
 */
const MAX_CHUNK_LINES = 200;

/**
 * Checks if a file is likely auto-generated or unreviewable based on its path.
 */
function isGeneratedOrUnreviewable(filePath: string): boolean {
  const generatedPatterns = [
    'node_modules/', 'vendor/', '__pycache__/', 
    '.min.js', '.min.css', 'package-lock.json',
    'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock',
    '.generated.', '/gen/', '/generated/', 'dist/', 'build/', 'out/'
  ];
  return generatedPatterns.some(pattern => filePath.includes(pattern));
}

function getChangedLineNumbers(diffFile: DiffFile, fileLineCount: number = 0): number[] {
  const changedLines = new Set<number>();

  for (const hunk of diffFile.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines = hunk.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        changedLines.add(newLine);
        newLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Deletion: anchor to the current newLine position
        // If it's the very end of the file with no trailing context,
        // newLine might point past the end of the new file, so we fallback.
        changedLines.add(Math.max(1, newLine));
        // Also capture the preceding line as a fallback for EOF edge cases
        if (newLine > 1) changedLines.add(newLine - 1);
        oldLine++;
      } else {
        // Context line
        oldLine++;
        newLine++;
      }
    }
  }

  return Array.from(changedLines).sort((a, b) => a - b);
}

/**
 * Maps the node type string from Tree-sitter to the CodeChunk nodeType enum.
 *
 * @param astType - The raw AST node type string.
 * @returns The corresponding CodeChunk nodeType.
 */
function mapNodeType(astType: string): CodeChunk['nodeType'] {
  switch (astType) {
    case 'function_declaration': return 'function';
    case 'class_declaration': return 'class';
    case 'method_definition': return 'method';
    case 'arrow_function': return 'arrow_function';
    case 'export_statement': return 'export';
    default: return 'block';
  }
}

/**
 * Generates CodeChunks from a set of diff files by intersecting
 * changed lines with AST structural nodes.
 *
 * Algorithm:
 * 1. For each changed file, read the full source from the repo.
 * 2. Parse the source with Tree-sitter to get structural nodes.
 * 3. Find which nodes contain at least one changed line.
 * 4. Build a CodeChunk for each affected node with surrounding context.
 *
 * If no AST can be generated (unsupported language), the engine falls back
 * to a simple line-range chunking approach.
 *
 * @param diffFiles - The files changed in the PR diff.
 * @param repoPath - Absolute path to the repository root (for reading full source files).
 * @returns An array of CodeChunks ready for AI analysis.
 */
export function generateChunks(
  diffFiles: DiffFile[],
  repoPath: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  for (const diffFile of diffFiles) {
    // Skip deleted files — nothing to review
    if (diffFile.changeType === 'deleted') continue;

    // Skip generated files
    if (isGeneratedOrUnreviewable(diffFile.filePath)) {
      console.log(`[Chunking] Skipping generated file: ${diffFile.filePath}`);
      continue;
    }

    const fullPath = join(repoPath, diffFile.filePath);
    const changedLines = getChangedLineNumbers(diffFile);

    if (changedLines.length === 0) continue;

    // Attempt to read the full source file for AST parsing
    let sourceCode: string;
    if (existsSync(fullPath)) {
      try {
        sourceCode = readFileSync(fullPath, 'utf-8');
      } catch {
        // If we can't read the file, fall back to diff content only
        sourceCode = '';
      }
    } else {
      sourceCode = '';
    }

    // Try AST-based chunking first
    const astNodes = sourceCode
      ? parseAndExtractNodes(sourceCode, diffFile.filePath)
      : [];

    if (astNodes.length > 0) {
      // AST-aware chunking: intersect changed lines with structural nodes
      const imports = extractImports(sourceCode, diffFile.filePath);

      // Track which changed lines have been claimed by a node
      const claimedLines = new Set<number>();

      for (const node of astNodes) {
        // Find changed lines that fall within this AST node's range
        const affectedLines = changedLines.filter(
          (line) => line >= node.startLine && line <= node.endLine
        );

        if (affectedLines.length === 0) continue;

        // Mark these lines as claimed
        affectedLines.forEach((line) => claimedLines.add(line));

        // Handle oversized nodes by splitting into sub-chunks
        const nodeLines = node.endLine - node.startLine + 1;
        if (nodeLines > MAX_CHUNK_LINES) {
          // Sub-split: create chunks around clusters of changed lines
          const lineGroups = clusterLines(affectedLines, 20);
          for (const group of lineGroups) {
            const start = Math.max(node.startLine, group[0]! - 10);
            const end = Math.min(node.endLine, group[group.length - 1]! + 10);
            const sourceLines = sourceCode.split('\n');
            const chunkContent = sourceLines.slice(start - 1, end).join('\n');

            chunks.push({
              chunkId: randomUUID(),
              filePath: diffFile.filePath,
              nodeType: mapNodeType(node.type),
              nodeName: node.name,
              startLine: start,
              endLine: end,
              content: chunkContent,
              surroundingContext: imports,
              changedLines: group,
            });
          }
        } else {
          chunks.push({
            chunkId: randomUUID(),
            filePath: diffFile.filePath,
            nodeType: mapNodeType(node.type),
            nodeName: node.name,
            startLine: node.startLine,
            endLine: node.endLine,
            content: node.text,
            surroundingContext: imports,
            changedLines: affectedLines,
          });
        }
      }

      // Handle orphan changed lines that don't fall within any AST node
      const orphanLines = changedLines.filter((line) => !claimedLines.has(line));
      if (orphanLines.length > 0) {
        const lineGroups = clusterLines(orphanLines, 15);
        const sourceLines = sourceCode.split('\n');

        for (const group of lineGroups) {
          const start = Math.max(1, group[0]! - 5);
          const end = Math.min(sourceLines.length, group[group.length - 1]! + 5);
          const chunkContent = sourceLines.slice(start - 1, end).join('\n');

          chunks.push({
            chunkId: randomUUID(),
            filePath: diffFile.filePath,
            nodeType: 'block',
            nodeName: null,
            startLine: start,
            endLine: end,
            content: chunkContent,
            surroundingContext: imports,
            changedLines: group,
          });
        }
      }
    } else {
      // Fallback: no AST available — use raw diff content as a single chunk
      const rawContent = diffFile.hunks.map((h) => h.content).join('\n');
      chunks.push({
        chunkId: randomUUID(),
        filePath: diffFile.filePath,
        nodeType: 'block',
        nodeName: null,
        startLine: changedLines[0] ?? 1,
        endLine: changedLines[changedLines.length - 1] ?? 1,
        content: rawContent,
        surroundingContext: '',
        changedLines,
      });
    }
  }

  return chunks;
}

/**
 * Groups nearby line numbers into clusters for sub-chunking.
 * Lines within `maxGap` of each other are grouped together.
 *
 * @param lines - Sorted array of line numbers.
 * @param maxGap - Maximum gap between lines to be considered the same cluster.
 * @returns An array of line number clusters.
 */
function clusterLines(lines: number[], maxGap: number): number[][] {
  if (lines.length === 0) return [];

  const groups: number[][] = [[lines[0]!]];
  for (let i = 1; i < lines.length; i++) {
    const currentLine = lines[i]!;
    const lastGroup = groups[groups.length - 1]!;
    const lastLine = lastGroup[lastGroup.length - 1]!;

    if (currentLine - lastLine <= maxGap) {
      lastGroup.push(currentLine);
    } else {
      groups.push([currentLine]);
    }
  }

  return groups;
}
