/**
 * @module intelligence/context-builder
 * Context Builder — Assembles the final enriched payload for the AI Provider.
 *
 * Combines outputs from the Technology Detector, Rule Engine, and Convention Extractor
 * into a single ReviewContext object. This is the "last mile" before AI inference:
 * the AI never sees raw diffs, only structured, pre-verified context.
 *
 * @see 05_REPOSITORY_INTELLIGENCE_PIPELINE.md Section 4.5 for architecture.
 */

import type {
  PullRequestEvent,
  ReviewContext,
  RuleEngineResult,
  TechnologyProfile,
} from '../types/index.js';

/**
 * Builds the complete ReviewContext payload from all pipeline stages.
 *
 * This function is the single assembly point that merges deterministic intelligence
 * (tech detection, rule engine findings, repo conventions) into the structured
 * payload consumed by the AI Provider.
 *
 * Business Rule: The AI Provider receives ONLY this structured context —
 * never raw diffs or unprocessed repository data.
 *
 * @param event - The normalized PullRequestEvent from the Git adapter.
 * @param technologyStack - The deterministic TechnologyProfile from the Tech Detector.
 * @param ruleEngineFindings - Pre-AI findings from the Rule Engine.
 * @param repositoryGuidelines - Concatenated conventions from the Convention Extractor.
 * @returns A fully assembled ReviewContext ready for AI inference.
 */
export function buildReviewContext(
  event: PullRequestEvent,
  technologyStack: TechnologyProfile,
  ruleEngineFindings: RuleEngineResult[],
  repositoryGuidelines: string,
  blastRadius?: Record<string, string[]>
): ReviewContext {
  return {
    pullRequestMetadata: {
      title: event.pullRequest.title,
      description: event.pullRequest.description,
      author: event.pullRequest.author,
    },
    technologyStack,
    repositoryGuidelines,
    ruleEngineFindings,
    blastRadius,
  };
}
