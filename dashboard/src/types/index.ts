export interface User {
  email: string;
  role: string;
}

export interface Repo {
  id: string;
  name: string;
  cloneUrl: string;
  _count?: {
    pullRequests: number;
  };
}

export interface Stats {
  totalRepositories: number;
  totalPullRequests: number;
  totalFindings: number;
  totalCostUsd: number;
  costData: { name: string; cost: number }[];
  severityData: { name: string; value: number }[];
}

export interface Finding {
  id: string;
  title: string;
  severity: string;
  ruleId?: string;
  filePath: string;
  lineNumber: number;
  confidence: number;
  evidence: string;
  recommendation: string;
  issueCode?: string;
  suggestedFix?: string;
}

export interface PullRequestDetail {
  repositoryId: string;
  title: string;
  prNumber: number;
  author: string;
  status: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  summary?: string;
  riskLevel?: string;
  suggestedTests?: string;
  errorMessage?: string;
  findings: Finding[];
}

export interface PullRequest {
  id: string;
  title: string;
  status: string;
  prNumber: number;
  author: string;
  createdAt: string;
  errorMessage?: string;
  _count?: {
    findings: number;
  };
}

export interface RepoData {
  repository: {
    name: string;
    fullName?: string;
    cloneUrl: string;
  };
  pullRequests: PullRequest[];
}
