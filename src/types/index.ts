/**
 * @module types
 * Core domain types and Zod schemas for the AI PR Reviewer Bot.
 *
 * These types represent the strict contracts between every layer of the system:
 * Git Adapters, Intelligence Pipeline, Tree-sitter Chunking, AI Providers, and the Post-AI Pipeline.
 * All AI output is validated at runtime using the Zod schemas defined here.
 */

import { z } from 'zod';

// =============================================================================
// Git Platform & Diff Types
// =============================================================================

/**
 * Represents a normalized Pull Request event, abstracted from the source
 * Git platform (GitHub, GitLab, or local diff).
 */
export interface PullRequestEvent {
  /** The originating platform identifier */
  platform: 'github' | 'gitlab' | 'local';

  /** Repository metadata */
  repository: {
    id: string;
    fullName: string;
    cloneUrl: string;
    defaultBranch: string;
  };

  /** Pull Request metadata */
  pullRequest: {
    number: number;
    headSha: string;
    baseSha: string;
    title: string;
    description: string;
    author: string;
  };

  /** The action that triggered the event */
  action: 'opened' | 'synchronize' | 'reopened';
}

/**
 * Represents a single file that was changed in the Pull Request diff.
 * Parsed from unified diff format.
 */
export interface DiffFile {
  /** Path to the file relative to the repository root */
  filePath: string;

  /** The type of change applied to the file */
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';

  /** Individual hunks (contiguous changed regions) within the file */
  hunks: DiffHunk[];

  /** Total number of lines added across all hunks */
  additions: number;

  /** Total number of lines deleted across all hunks */
  deletions: number;
}

/**
 * Represents a contiguous region of changes within a single diff file.
 * Maps directly to a unified diff hunk header (e.g., @@ -10,5 +10,7 @@).
 */
export interface DiffHunk {
  /** Starting line number in the old file */
  oldStart: number;

  /** Number of lines from the old file in this hunk */
  oldLines: number;

  /** Starting line number in the new file */
  newStart: number;

  /** Number of lines from the new file in this hunk */
  newLines: number;

  /** Raw text content of the hunk (with +/- prefixes) */
  content: string;
}

// =============================================================================
// Technology Detection Types
// =============================================================================

/**
 * The output of the deterministic Technology Detector.
 * Identifies languages, frameworks, and tooling without any AI inference.
 */
export interface TechnologyProfile {
  /** Detected programming languages with approximate percentage usage */
  languages: Array<{ name: string; percentage: number }>;

  /** Detected frameworks (e.g., "Next.js", "Express", "Django") */
  frameworks: string[];

  /** Detected testing libraries (e.g., "Jest", "Vitest", "pytest") */
  testingLibraries: string[];

  /** Detected package managers (e.g., "npm", "yarn", "pnpm") */
  packageManagers: string[];

  /** Detected linters and formatters (e.g., "ESLint", "Prettier") */
  linters: string[];
}

// =============================================================================
// Rule Engine Types
// =============================================================================

/** Severity levels for Rule Engine findings, ranked by priority */
export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * A single finding produced by the deterministic Rule Engine.
 * These are generated BEFORE AI inference and passed as additional context.
 */
export interface RuleEngineResult {
  /** Unique identifier for the rule that triggered this finding */
  ruleId: string;

  /** Human-readable description of the rule violation */
  message: string;

  /** The file path where the violation was detected */
  filePath: string;

  /** The line number where the violation was detected, if applicable */
  lineNumber?: number;

  /** Severity of the violation */
  severity: RuleSeverity;

  /** Whether this finding should halt the review pipeline entirely */
  blocking: boolean;
}

// =============================================================================
// Tree-sitter Chunking Types
// =============================================================================

/**
 * Represents a structural code chunk extracted from the AST.
 * This is the fundamental unit sent to the AI Provider for analysis.
 *
 * @example A single function, a class definition, or a React component.
 */
export interface CodeChunk {
  /** Unique identifier for this chunk within the PR */
  chunkId: string;

  /** Path to the source file this chunk was extracted from */
  filePath: string;

  /** The type of AST node this chunk represents */
  nodeType: 'function' | 'class' | 'method' | 'arrow_function' | 'export' | 'block';

  /** The name of the function/class/method, if identifiable */
  nodeName: string | null;

  /** Start line in the original file (1-indexed) */
  startLine: number;

  /** End line in the original file (1-indexed) */
  endLine: number;

  /** The full source code content of this structural block */
  content: string;

  /** Surrounding context: imports, type declarations, class fields visible to this chunk */
  surroundingContext: string;

  /** The specific lines within this chunk that were changed in the diff */
  changedLines: number[];
}

// =============================================================================
// AI Context & Provider Types
// =============================================================================

/**
 * The enriched context payload assembled by the Context Builder.
 * This is the complete input package sent to the AI Provider.
 *
 * Business Rule: The AI never receives raw diffs. It always receives
 * structured context including technology stack, repo guidelines,
 * and pre-computed rule engine findings.
 */
export interface ReviewContext {
  /** Metadata about the Pull Request */
  pullRequestMetadata: {
    title: string;
    description: string;
    author: string;
  };

  /** The deterministic technology profile of the repository */
  technologyStack: TechnologyProfile;

  /** Repository-specific guidelines extracted from CONTRIBUTING.md, .cursorrules, etc. */
  repositoryGuidelines: string;

  /** Pre-AI findings from the deterministic Rule Engine */
  ruleEngineFindings: RuleEngineResult[];

  /** Dependency graph mapping modified files to files that import them */
  blastRadius?: Record<string, string[]>;
}

/**
 * Cost and usage metrics returned by an AI provider after inference.
 */
export interface ProviderCostMetrics {
  /** The provider that was used (e.g., "gemini", "ollama") */
  provider: string;

  /** Number of input tokens consumed */
  inputTokens: number;

  /** Number of output tokens generated */
  outputTokens: number;

  /** Wall-clock time for inference in milliseconds */
  inferenceMs: number;

  /** Estimated USD cost of this inference call */
  estimatedCostUsd: number;
}

// =============================================================================
// AI Review Finding Types — The Strict Output Schema
// =============================================================================

/** Severity classification for AI-generated findings */
export const SeverityEnum = z.enum(['Critical', 'High', 'Medium', 'Low']);
export type Severity = z.infer<typeof SeverityEnum>;

/**
 * Zod schema for validating the structured output from AI providers.
 * Every AI response MUST conform to this schema or be retried.
 *
 * @see 02_PRODUCT_REQUIREMENTS.md Section 4.3 for the business requirements.
 */
export const ReviewFindingSchema = z.object({
  /** Concise title summarizing the issue */
  title: z.string().min(1).max(200),

  /** Severity classification */
  severity: SeverityEnum,

  /** Confidence percentage (0-100) that this finding is legitimate */
  confidence: z.number().min(0).max(100),

  /** The business, security, or technical impact of this issue */
  impact: z.string().min(1).describe('The business, security, or technical impact of this issue'),

  /** Technical evidence explaining why this was flagged */
  evidence: z.string().min(1),

  /** Actionable recommendation to resolve the issue */
  recommendation: z.string().min(1),

  /** A snippet of the original code containing the issue */
  issueCode: z.string().optional(),

  /** Optional code snippet showing the corrected implementation */
  suggestedFix: z.string().optional(),

  /** Optional list of references (e.g., documentation, OWASP guidelines) */
  references: z.array(z.string()).optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * Zod schema for the complete AI response: an array of findings.
 */
export const ReviewFindingsArraySchema = z.array(ReviewFindingSchema);

/**
 * A finding that has been fully enriched with file and line context
 * after the Post-AI Pipeline processes it.
 */
export interface EnrichedFinding extends ReviewFinding {
  /** The file path where this finding applies */
  filePath: string;

  /** The line number where this finding applies */
  lineNumber: number;

  /** The chunk ID that generated this finding */
  sourceChunkId: string;
}

/**
 * The complete result of a single chunk analysis by the AI provider.
 * Contains both per-chunk findings and optional PR-level metadata.
 */
export interface ChunkAnalysisResult {
  /** The enriched findings for this chunk */
  findings: EnrichedFinding[];

  /** AI-generated summary of what this code change does */
  summary?: string;

  /** AI-assessed risk level: Low, Medium, High, or Critical */
  risk?: string;

  /** AI-suggested test scenarios that should be written or verified */
  suggestedTests?: string[];
}

// =============================================================================
// Prompt Registry Types
// =============================================================================

/**
 * Configuration for a prompt template loaded from the Prompt Registry.
 */
export interface PromptConfig {
  /** Unique name of the prompt (e.g., "security", "frontend", "general") */
  name: string;

  /** Version string for A/B testing and rollbacks */
  version: string;

  /** The system prompt template (may contain {{variable}} placeholders) */
  systemPrompt: string;

  /** The user prompt template (may contain {{variable}} placeholders) */
  userPrompt: string;
}
