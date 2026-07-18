/**
 * @module pipeline/result-merger
 * Post-AI Result Merger — Deduplicates and ranks findings from parallel chunk analysis.
 *
 * When multiple chunks are analyzed in parallel, the AI may produce duplicate
 * or near-duplicate findings. This module merges them using title + file similarity
 * and applies a configurable confidence threshold to filter low-quality results.
 *
 * @see 07_CHUNKED_ANALYSIS_AND_TREE_SITTER.md Section 4.3 (Round 3: Global Verification Merge).
 */

import type { EnrichedFinding } from '../types/index.js';

/** Severity ranking used for stable sorting (Critical > High > Medium > Low) */
const SEVERITY_RANK: Record<string, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

/**
 * Computes the Jaccard similarity coefficient between two strings
 * by comparing their word-level token sets. This is more robust than
 * character-overlap for detecting semantically duplicate finding titles.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns A similarity ratio between 0 and 1.
 */
function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Tokenize into lowercase words, filtering out noise
  const tokenize = (s: string): Set<string> =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);

  // Jaccard index: |A ∩ B| / |A ∪ B|
  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0.0 : intersectionSize / unionSize;
}

/**
 * Checks if two findings are duplicates based on title similarity and
 * file/line proximity.
 *
 * @param a - First finding.
 * @param b - Second finding.
 * @returns True if the findings are considered duplicates.
 */
function isDuplicate(a: EnrichedFinding, b: EnrichedFinding): boolean {
  // Must be in the same file
  if (a.filePath !== b.filePath) return false;

  // Check title similarity (threshold: 70%)
  if (similarityRatio(a.title, b.title) < 0.7) return false;

  // Check line proximity (within 20 lines of each other)
  if (Math.abs(a.lineNumber - b.lineNumber) > 20) return false;

  return true;
}

/**
 * Merges, deduplicates, and ranks findings from parallel AI analysis.
 *
 * Business Rules:
 * 1. Findings below the confidence threshold are filtered out.
 * 2. Duplicate findings (same title + file + nearby lines) are merged,
 *    keeping the one with higher confidence.
 * 3. Results are sorted by severity (Critical first) then by confidence (highest first).
 *
 * @param findings - Raw findings collected from all parallel chunk analyses.
 * @param confidenceThreshold - Minimum confidence percentage (default: 85).
 * @returns Deduplicated and ranked findings ready for publishing.
 */
export function mergeAndRankFindings(
  findings: EnrichedFinding[],
  confidenceThreshold: number = 85
): EnrichedFinding[] {
  // Step 1: Filter by confidence threshold
  const filtered = findings.filter((f) => f.confidence >= confidenceThreshold);

  // Step 2: Deduplicate using pairwise comparison
  const unique: EnrichedFinding[] = [];

  for (const finding of filtered) {
    const existingIdx = unique.findIndex((u) => isDuplicate(u, finding));

    if (existingIdx >= 0) {
      // Keep the finding with higher confidence
      if (finding.confidence > unique[existingIdx]!.confidence) {
        unique[existingIdx] = finding;
      }
    } else {
      unique.push(finding);
    }
  }

  // Step 3: Sort by severity (Critical → Low), then by confidence (highest first)
  unique.sort((a, b) => {
    const severityDiff =
      (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (severityDiff !== 0) return severityDiff;
    return b.confidence - a.confidence;
  });

  return unique;
}
