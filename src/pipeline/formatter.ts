/**
 * @module pipeline/formatter
 * CLI Output Formatter — Renders AI findings as rich console output.
 *
 * Formats the final EnrichedFinding array into colored, structured
 * console output with severity badges, file references, code snippets,
 * and cost metrics summary.
 */

import chalk from 'chalk';
import type { EnrichedFinding, ProviderCostMetrics, RuleEngineResult } from '../types/index.js';
import { isVulnerabilityCitation, getUnverifiedLabel } from './cve-utils.js';

/** Maps severity levels to chalk color functions for visual distinction */
const SEVERITY_COLORS: Record<string, (text: string) => string> = {
  Critical: chalk.bgRed.white.bold,
  High: chalk.red.bold,
  Medium: chalk.yellow.bold,
  Low: chalk.cyan,
};

/** Maps severity levels to emoji badges for quick scanning */
const SEVERITY_BADGES: Record<string, string> = {
  Critical: '🔴',
  High: '🟠',
  Medium: '🟡',
  Low: '🔵',
};

/**
 * Formats a single AI finding into a multi-line console block.
 *
 * @param finding - The enriched finding to format.
 * @param index - The 1-based index of this finding in the list.
 * @returns A formatted string block ready for console output.
 */
function formatFinding(finding: EnrichedFinding, index: number): string {
  const badge = SEVERITY_BADGES[finding.severity] ?? '⚪';
  const colorFn = SEVERITY_COLORS[finding.severity] ?? chalk.white;
  const separator = chalk.gray('─'.repeat(70));

  const confidenceLabel = isVulnerabilityCitation(finding.title, finding.evidence)
    ? chalk.italic(getUnverifiedLabel())
    : `${finding.confidence}%`;

  const lines: string[] = [
    separator,
    `${badge} ${colorFn(`[${finding.severity}]`)} ${chalk.bold(finding.title)}`,
    `   ${chalk.gray('File:')} ${chalk.underline(finding.filePath)}:${finding.lineNumber}`,
    `   ${chalk.gray('Confidence:')} ${confidenceLabel}`,
    `   ${chalk.gray('Evidence:')} ${finding.evidence}`,
    `   ${chalk.gray('Recommendation:')} ${chalk.green(finding.recommendation)}`,
  ];

  if (finding.suggestedFix) {
    lines.push(`   ${chalk.gray('Suggested Fix:')}`);
    lines.push(chalk.green('   ' + finding.suggestedFix.replace(/\n/g, '\n   ')));
  }

  return lines.join('\n');
}

/**
 * Formats Rule Engine (deterministic) findings for console output.
 *
 * @param findings - The Rule Engine findings to format.
 * @returns A formatted string block, or empty string if no findings.
 */
function formatRuleEngineFindings(findings: RuleEngineResult[]): string {
  if (findings.length === 0) return '';

  const lines: string[] = [
    '',
    chalk.bold.underline('🔧 Deterministic Rule Engine Findings'),
    '',
  ];

  for (const finding of findings) {
    const icon = finding.blocking ? '🚫' : 'ℹ️';
    const severity = finding.severity.toUpperCase();
    lines.push(
      `  ${icon} ${chalk.gray(`[${finding.ruleId}]`)} ${chalk.yellow(`[${severity}]`)} ${finding.message}`
    );
    lines.push(`     ${chalk.gray('File:')} ${finding.filePath}`);
  }

  return lines.join('\n');
}

/**
 * Formats the cost metrics summary for console output.
 *
 * @param metrics - The accumulated AI provider cost metrics.
 * @returns A formatted string block with token/cost details.
 */
function formatCostMetrics(metrics: ProviderCostMetrics): string {
  return [
    '',
    chalk.bold.underline('📊 AI Inference Metrics'),
    '',
    `  ${chalk.gray('Provider:')}      ${metrics.provider}`,
    `  ${chalk.gray('Input Tokens:')}  ${metrics.inputTokens.toLocaleString()}`,
    `  ${chalk.gray('Output Tokens:')} ${metrics.outputTokens.toLocaleString()}`,
    `  ${chalk.gray('Inference Time:')} ${metrics.inferenceMs.toLocaleString()}ms`,
    `  ${chalk.gray('Estimated Cost:')} $${metrics.estimatedCostUsd.toFixed(5)}`,
  ].join('\n');
}

/**
 * Renders the complete review output to the console.
 *
 * @param aiFindings - The deduplicated and ranked AI findings.
 * @param ruleFindings - The deterministic Rule Engine findings.
 * @param metrics - The AI provider cost metrics.
 * @param totalChunks - The number of code chunks that were analyzed.
 */
export function renderReviewOutput(
  aiFindings: EnrichedFinding[],
  ruleFindings: RuleEngineResult[],
  metrics: ProviderCostMetrics,
  totalChunks: number
): void {
  console.log('');
  console.log(chalk.bold.magenta('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.magenta('                    AI PR REVIEWER BOT'));
  console.log(chalk.bold.magenta('═══════════════════════════════════════════════════════════════'));

  // Rule Engine findings first (these are deterministic / pre-AI)
  console.log(formatRuleEngineFindings(ruleFindings));

  // AI Findings
  if (aiFindings.length > 0) {
    console.log('');
    console.log(chalk.bold.underline(`🤖 AI Review Findings (${aiFindings.length} issues from ${totalChunks} chunks)`));

    for (let i = 0; i < aiFindings.length; i++) {
      console.log(formatFinding(aiFindings[i]!, i + 1));
    }

    console.log(chalk.gray('─'.repeat(70)));
  } else if (totalChunks > 0 && metrics.inputTokens === 0 && metrics.outputTokens === 0) {
    // AI analysis failed or was unavailable (no tokens consumed despite having chunks to review)
    console.log('');
    console.log(chalk.yellow.bold('⚠️  AI analysis was unavailable or failed'));
    console.log(chalk.yellow('   No AI findings were generated — the AI provider could not be reached'));
    console.log(chalk.yellow('   or returned errors for all chunks. Check your API key configuration.'));
    console.log(chalk.yellow(`   Provider: ${metrics.provider}, Chunks to review: ${totalChunks}`));
  } else {
    console.log('');
    console.log(chalk.green.bold('✅ No AI findings — the code looks clean!'));
  }

  // Cost summary
  console.log(formatCostMetrics(metrics));

  console.log('');
  console.log(chalk.bold.magenta('═══════════════════════════════════════════════════════════════'));
}
