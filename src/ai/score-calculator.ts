/**
 * @module ai/score-calculator
 * Calculates an objective 0-10 score for the PR based on AI findings.
 */

import { ReviewFinding } from '../types/index.js';

export interface ReviewScore {
  score: number;
  interpretation: string;
  deductions: number;
}

/**
 * Get human-readable interpretation of a score.
 */
function getScoreInterpretation(score: number): string {
  if (score === 10) return "Perfect - No issues found";
  if (score >= 9) return "Excellent - Only minor quality improvements";
  if (score >= 8) return "Very Good - 1-2 minor issues, no critical/security concerns";
  if (score >= 7) return "Good - Few minor issues, no breaking changes";
  if (score >= 6) return "Acceptable - Some quality/performance issues, no critical bugs";
  if (score >= 5) return "Needs Improvement - Multiple bugs/quality issues OR 1 security concern";
  if (score >= 4) return "Poor - Multiple bugs + quality issues OR 2 security concerns";
  if (score >= 3) return "Very Poor - Critical issues OR 3+ security concerns";
  if (score >= 2) return "Severe - Multiple critical issues + security concerns";
  if (score >= 1) return "Unacceptable - Blocking/breaking changes, severe security issues";
  return "Rejected - Code cannot be merged safely";
}

/**
 * Calculate objective score based on issue counts and severity.
 * 
 * @param findings The array of AI review findings
 * @returns A ReviewScore object
 */
export function calculateReviewScore(findings: ReviewFinding[]): ReviewScore {
  const baseScore = 10;
  
  let deductionCritical = 0;
  let deductionSecurity = 0; // We treat 'High' severity that mentions 'security' or 'OWASP' as security
  let deductionBugs = 0;
  
  for (const finding of findings) {
    const severity = finding.severity.toLowerCase();
    
    // Check if it's a security issue
    const isSecurity = 
      finding.evidence.toLowerCase().includes('owasp') || 
      finding.evidence.toLowerCase().includes('security') ||
      finding.title.toLowerCase().includes('security');

    if (isSecurity) {
      deductionSecurity += 1.5;
      continue;
    }

    if (severity === 'critical') {
      deductionCritical += 2.0;
    } else if (severity === 'high') {
      deductionBugs += 0.8;
    } else if (severity === 'medium') {
      deductionBugs += 0.5;
    } else if (severity === 'low') {
      deductionBugs += 0.2;
    }
  }

  // Soft penalties based on confidence
  let deductionConfidence = 0;
  for (const finding of findings) {
    if (finding.confidence < 80) {
      deductionConfidence += 0.5;
    }
  }

  const totalDeductions = deductionCritical + deductionSecurity + deductionBugs + deductionConfidence;
  
  // Score bounded 0–10
  const finalScore = Math.max(0, Math.min(10, baseScore - totalDeductions));
  const roundedScore = Math.round(finalScore * 10) / 10;

  return {
    score: roundedScore,
    interpretation: getScoreInterpretation(Math.floor(roundedScore)),
    deductions: Math.round(totalDeductions * 100) / 100
  };
}
