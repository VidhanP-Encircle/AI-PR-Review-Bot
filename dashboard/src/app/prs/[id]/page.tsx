"use client";

import { Activity, Code2, GitPullRequest, LogOut, Search, Settings, ArrowLeft, Clock, ShieldAlert, AlertTriangle, Info, CheckCircle2 } from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "../../../lib/api";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ReactMarkdown from 'react-markdown';

const getLanguageFromPath = (path?: string) => {
  if (!path) return 'javascript';
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'jsx': return 'javascript';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'rs': return 'rust';
    case 'css': return 'css';
    case 'html': return 'html';
    case 'json': return 'json';
    case 'yaml': case 'yml': return 'yaml';
    case 'sh': return 'bash';
    case 'c': case 'cpp': case 'h': case 'hpp': return 'cpp';
    default: return 'javascript';
  }
};

const cleanCodeBlock = (code: string, filePath?: string) => {
  const fallbackLanguage = getLanguageFromPath(filePath);
  if (!code) return { language: fallbackLanguage, code: '' };
  
  // Match markdown code blocks anywhere in the text
  const match = code.match(/```(\w+)?\n([\s\S]*?)```/);
  if (match) {
    return { language: match[1] || fallbackLanguage, code: match[2].trim() };
  }
  return { language: fallbackLanguage, code: code.trim() };
};

import type { User, Finding, PullRequestDetail } from '../../../types';

export default function PullRequestPage() {
  const router = useRouter();
  const params = useParams();
  const prId = params.id as string;
  
  const { data: session, status } = useSession();
  const user = session?.user;
  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
      return;
    }
    if (status === 'authenticated') {
      async function loadData() {
        try {
          const prData = await fetchWithAuth(`/prs/${prId}/findings`);
          setPr(prData as PullRequestDetail);
        } catch (err: unknown) {
          console.error(err);
        } finally {
          setLoading(false);
        }
      }
      loadData();
    }
  }, [status, router, prId]);

  const handleLogout = async () => {
    await signOut({ redirect: false });
    router.push('/login');
  };

  if (loading || status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-[#09090b] text-white">Loading review findings...</div>;
  }

  if (!pr) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#09090b] text-white gap-4">
        <p>Pull Request not found.</p>
        <button onClick={() => router.back()} className="text-primary hover:underline flex items-center gap-2">
          <ArrowLeft size={16} /> Go Back
        </button>
      </div>
    );
  }

  const getSeverityIcon = (severity: string) => {
    switch (severity.toLowerCase()) {
      case 'critical': return <ShieldAlert size={20} className="text-red-500" />;
      case 'high': return <AlertTriangle size={20} className="text-orange-500" />;
      case 'medium': return <AlertTriangle size={20} className="text-yellow-500" />;
      case 'low': return <Info size={20} className="text-blue-500" />;
      default: return <Info size={20} className="text-zinc-500" />;
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity.toLowerCase()) {
      case 'critical': return 'border-red-500/30 bg-red-500/5';
      case 'high': return 'border-orange-500/30 bg-orange-500/5';
      case 'medium': return 'border-yellow-500/30 bg-yellow-500/5';
      case 'low': return 'border-blue-500/30 bg-blue-500/5';
      default: return 'border-zinc-500/30 bg-zinc-500/5';
    }
  };

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'COMPLETED': return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
      case 'FAILED': return 'text-red-400 bg-red-400/10 border-red-400/20';
      case 'AI_REVIEWING': return 'text-purple-400 bg-purple-400/10 border-purple-400/20';
      default: return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
    }
  };

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-100 font-sans selection:bg-primary/30">
      {/* SIDEBAR */}
      <aside className="w-64 border-r border-white/5 bg-black/20 backdrop-blur-xl flex flex-col z-10 hidden md:flex">
        <div className="p-6">
          <Link href="/" className="flex items-center gap-3 text-primary font-bold text-xl tracking-tight hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 rounded-lg bg-primary/20 border border-primary/50 flex items-center justify-center">
              <Code2 size={18} className="text-primary-light" />
            </div>
            AI Reviewer
          </Link>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1">
          <Link href="/" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors">
            <Activity size={18} /> Dashboard
          </Link>
          <Link href="/repos" className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 text-zinc-100 font-medium transition-colors">
            <GitPullRequest size={18} className="text-primary" /> Repositories
          </Link>
          <Link href="/settings" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors">
            <Settings size={18} /> Settings
          </Link>
        </nav>

        <div className="p-4 border-t border-white/5">
          <div className="flex items-center gap-3 px-3 py-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold">
              {user?.email?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1 truncate">
              <p className="text-sm font-medium truncate">{user?.email || 'User'}</p>
              <p className="text-xs text-zinc-500 capitalize">{user?.role || 'Admin'}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition-colors text-sm font-medium">
            <LogOut size={18} /> Sign Out
          </button>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 overflow-y-auto relative">
        
        <header className="sticky top-0 z-20 glass-panel border-b border-white/5 px-8 py-4 flex items-center gap-4">
          <Link href={`/repos/${pr.repositoryId}`} className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div className="flex flex-col">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <GitPullRequest size={20} className="text-primary" />
              {pr.title} <span className="text-zinc-500 font-mono text-sm ml-2">#{pr.prNumber}</span>
            </h2>
          </div>
        </header>

        <div className="p-8 max-w-5xl mx-auto space-y-8">
          
          {/* PR Details Summary */}
          <div className="glass-panel rounded-2xl border border-white/5 p-6 flex flex-wrap gap-8 items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm text-zinc-400">Author</p>
              <div className="font-medium flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs font-bold">
                  {pr.author.charAt(0).toUpperCase()}
                </div>
                {pr.author}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-zinc-400">Status</p>
              <span className={`inline-block text-xs px-2.5 py-0.5 rounded-full border ${getStatusColor(pr.status)}`}>
                {pr.status}
              </span>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-zinc-400">Commits</p>
              <p className="font-mono text-sm bg-white/5 px-2 py-1 rounded w-max">
                {pr.baseSha.substring(0,7)} → {pr.headSha.substring(0,7)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-zinc-400">Created</p>
              <p className="flex items-center gap-2 text-sm">
                <Clock size={16} className="text-zinc-500" />
                {new Date(pr.createdAt).toLocaleString()}
              </p>
            </div>
          </div>

          {/* Error Message if Failed or Retrying */}
          {pr.errorMessage && pr.status === 'FAILED' && (
            <div className="glass-panel rounded-2xl border border-red-500/30 bg-red-500/5 p-6 flex flex-col gap-2">
              <h3 className="text-sm font-medium text-red-400 uppercase tracking-wider flex items-center gap-2">
                <ShieldAlert size={18} />
                Analysis Failed
              </h3>
              <p className="text-red-200/80">{pr.errorMessage}</p>
            </div>
          )}
          {pr.errorMessage && pr.status !== 'FAILED' && (
            <div className="glass-panel rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 flex flex-col gap-2">
              <h3 className="text-sm font-medium text-amber-400 uppercase tracking-wider flex items-center gap-2">
                <AlertTriangle size={18} />
                Analysis Interrupted - Retrying
              </h3>
              <p className="text-amber-200/80">{pr.errorMessage}</p>
            </div>
          )}

          {/* ── MVP: Summary Card ──────────────────────────────────────── */}
          {pr.summary && (
            <div className="glass-panel rounded-2xl border border-white/5 p-6">
              <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-3">Summary</h3>
              <div className="text-zinc-200 text-lg leading-relaxed prose prose-invert prose-p:my-1 prose-strong:text-white max-w-none">
                <ReactMarkdown>{pr.summary}</ReactMarkdown>
              </div>
            </div>
          )}

          {/* ── MVP: Risk Level + Suggested Tests ─────────────────────── */}
          <div className="flex flex-col gap-6">
            {/* Risk Badge */}
            {pr.riskLevel && (
              <div className="glass-panel rounded-2xl border border-white/5 p-6">
                <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-3">Risk Level</h3>
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center gap-2 text-2xl font-bold px-4 py-2 rounded-xl border ${
                    pr.riskLevel === 'Critical' ? 'text-red-400 bg-red-400/10 border-red-400/20' :
                    pr.riskLevel === 'High' ? 'text-orange-400 bg-orange-400/10 border-orange-400/20' :
                    pr.riskLevel === 'Medium' ? 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' :
                    'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
                  }`}>
                    <span>{pr.riskLevel === 'Critical' ? '🔴' : pr.riskLevel === 'High' ? '🟠' : pr.riskLevel === 'Medium' ? '🟡' : '🟢'}</span>
                    <span>{pr.riskLevel}</span>
                  </span>
                </div>
              </div>
            )}

            {/* Suggested Tests */}
            {pr.suggestedTests && (() => {
              let tests: string[] = [];
              try { tests = JSON.parse(pr.suggestedTests); } catch {}
              if (tests.length === 0) return null;
              return (
                <div className="glass-panel rounded-2xl border border-white/5 p-6">
                  <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-3">Suggested Tests</h3>
                  <ul className="space-y-2">
                    {tests.map((test: string, i: number) => (
                      <li key={i} className="flex items-start gap-3 text-zinc-300">
                        <span className="mt-1 w-5 h-5 rounded border border-white/10 bg-white/5 flex items-center justify-center text-xs shrink-0">
                          {i + 1}
                        </span>
                        <span className="leading-relaxed">{test}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium flex items-center gap-2">
              <ShieldAlert size={20} className="text-primary" />
              Review Findings
            </h3>
            <div className="text-sm text-zinc-500">{pr.findings?.length || 0} issues identified</div>
          </div>

          {/* Findings List */}
          <div className="space-y-4">
            {(!pr.findings || pr.findings.length === 0) ? (
              <div className="glass-panel rounded-2xl border border-white/5 p-12 text-center flex flex-col items-center gap-4">
                <CheckCircle2 size={48} className="text-emerald-500/50" />
                <div>
                  <h4 className="text-lg font-medium text-emerald-400">No Issues Found</h4>
                  <p className="text-zinc-500 mt-1">The AI reviewer did not find any significant issues in this pull request.</p>
                </div>
              </div>
            ) : (
              pr.findings.map((finding: Finding) => (
                <div key={finding.id} className={`glass-panel rounded-2xl border ${getSeverityColor(finding.severity)} overflow-hidden transition-all duration-300 hover:shadow-2xl hover:-translate-y-1`}>
                  
                  {/* Finding Header */}
                  <div className="p-5 border-b border-white/5 flex items-start gap-4">
                    <div className="mt-1 bg-black/20 p-2 rounded-lg">
                      {getSeverityIcon(finding.severity)}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <h4 className="font-medium text-lg">{finding.title}</h4>
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${getSeverityColor(finding.severity)} font-medium uppercase tracking-wider`}>
                          {finding.severity}
                        </span>
                        {finding.ruleId && (
                          <span className="text-xs px-2 py-0.5 rounded bg-white/10 text-zinc-300 font-mono">
                            {finding.ruleId}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-zinc-400 flex items-center gap-2 font-mono mt-2 bg-black/30 p-2 rounded w-fit">
                        <Code2 size={14} className="text-zinc-500" />
                        {finding.filePath}:{finding.lineNumber}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-zinc-500 mb-1">Confidence</div>
                      <div className="font-mono text-sm bg-black/20 px-2 py-1 rounded text-zinc-300">
                        {finding.confidence}%
                      </div>
                    </div>
                  </div>

                  {/* Finding Body */}
                  <div className="p-5 space-y-6">
                    <div>
                      <h5 className="text-sm font-medium text-zinc-500 mb-2 uppercase tracking-wider">Evidence</h5>
                      <div className="text-zinc-300 bg-white/[0.02] p-4 rounded-xl border border-white/5 leading-relaxed prose prose-invert prose-p:my-1 prose-strong:text-white prose-a:text-primary max-w-none">
                        <ReactMarkdown>{finding.evidence}</ReactMarkdown>
                      </div>
                    </div>
                    
                    <div>
                      <h5 className="text-sm font-medium text-zinc-500 mb-2 uppercase tracking-wider">Recommendation</h5>
                      <div className="text-zinc-200 bg-primary/5 p-4 rounded-xl border border-primary/20 leading-relaxed prose prose-invert prose-p:my-1 prose-strong:text-white prose-a:text-primary max-w-none">
                        <ReactMarkdown>{finding.recommendation}</ReactMarkdown>
                      </div>
                    </div>

                    <div className="flex flex-col xl:flex-row gap-6">
                      {finding.issueCode && (() => {
                        const { language, code } = cleanCodeBlock(finding.issueCode, finding.filePath);
                        return (
                          <div className="flex-1">
                            <h5 className="text-sm font-medium text-red-400 mb-2 uppercase tracking-wider flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-red-500"></span>
                              Issue Code
                            </h5>
                            <div className="rounded-xl overflow-hidden border border-red-500/20 bg-[#0d1117] shadow-inner">
                              <div className="bg-red-500/10 px-4 py-2 flex items-center gap-2 border-b border-red-500/20">
                                 <div className="flex gap-1.5">
                                   <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                                   <div className="w-3 h-3 rounded-full bg-white/20"></div>
                                   <div className="w-3 h-3 rounded-full bg-white/20"></div>
                                 </div>
                                 <span className="text-xs text-red-200/70 font-mono ml-2">{finding.filePath}</span>
                              </div>
                              <SyntaxHighlighter
                                language={language}
                                style={vscDarkPlus}
                                showLineNumbers={true}
                                startingLineNumber={finding.lineNumber || 1}
                                customStyle={{ margin: 0, background: 'transparent', padding: '1.25rem', fontSize: '0.875rem' }}
                              >
                                {code}
                              </SyntaxHighlighter>
                            </div>
                          </div>
                        );
                      })()}

                      {finding.suggestedFix && (() => {
                        const { language, code } = cleanCodeBlock(finding.suggestedFix, finding.filePath);
                        return (
                          <div className="flex-1">
                            <h5 className="text-sm font-medium text-green-400 mb-2 uppercase tracking-wider flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-green-500"></span>
                              Suggested Fix
                            </h5>
                            <div className="rounded-xl overflow-hidden border border-green-500/20 bg-[#0d1117] shadow-inner">
                              <div className="bg-green-500/10 px-4 py-2 flex items-center gap-2 border-b border-green-500/20">
                                 <div className="flex gap-1.5">
                                   <div className="w-3 h-3 rounded-full bg-white/20"></div>
                                   <div className="w-3 h-3 rounded-full bg-white/20"></div>
                                   <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
                                 </div>
                                 <span className="text-xs text-green-200/70 font-mono ml-2">{finding.filePath}</span>
                              </div>
                              <SyntaxHighlighter
                                language={language}
                                style={vscDarkPlus}
                                showLineNumbers={true}
                                startingLineNumber={finding.lineNumber || 1}
                                customStyle={{ margin: 0, background: 'transparent', padding: '1.25rem', fontSize: '0.875rem' }}
                              >
                                {code}
                              </SyntaxHighlighter>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
