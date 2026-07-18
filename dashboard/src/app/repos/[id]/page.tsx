"use client";

import { Activity, Code2, GitPullRequest, LogOut, Search, Settings, ArrowLeft, Clock, CheckCircle2, AlertCircle, RefreshCw, Trash2 } from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "../../../lib/api";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";

import type { User, PullRequest, RepoData } from '../../../types';

export default function RepositoryPage() {
  const router = useRouter();
  const params = useParams();
  const repoId = params.id as string;
  
  const { data: session, status } = useSession();
  const user = session?.user;
  const [data, setData] = useState<RepoData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
      return;
    }
    if (status === 'authenticated') {
      async function loadData() {
        try {
          const repoData = await fetchWithAuth(`/repos/${repoId}/prs`);
          setData(repoData as RepoData);
        } catch (err: unknown) {
          console.error(err);
        } finally {
          setLoading(false);
        }
      }
      loadData();
    }
  }, [status, router, repoId]);

  const handleLogout = async () => {
    await signOut({ redirect: false });
    router.push('/login');
  };

  const handleDeleteRepo = async () => {
    if (!confirm('Are you sure you want to delete this repository? This will permanently delete all associated PRs and findings.')) {
      return;
    }
    try {
      await fetchWithAuth(`/repos/${repoId}`, { method: 'DELETE' });
      router.push('/');
    } catch (err: unknown) {
      alert('Failed to delete repository');
      console.error(err);
    }
  };

  const handleClearCache = async () => {
    if (!confirm('Are you sure you want to clear the repository cache? It will be re-cloned on the next review.')) {
      return;
    }
    try {
      const res = await fetchWithAuth(`/cache/repos/${repoId}`, { method: 'DELETE' });
      if (res.deleted) {
        alert('Cache cleared successfully');
      } else {
        alert('Cache folder not found (already clear).');
      }
    } catch (err: unknown) {
      alert('Failed to clear cache');
      console.error(err);
    }
  };

  if (loading || status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-[#09090b] text-white">Loading repository data...</div>;
  }

  if (!data || !data.repository) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#09090b] text-white gap-4">
        <p>Repository not found.</p>
        <Link href="/" className="text-primary hover:underline flex items-center gap-2">
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
      </div>
    );
  }

  const { repository, pullRequests } = data;

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
      {/* SIDEBAR (Duplicated from main dashboard for consistency) */}
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
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px] -z-10 pointer-events-none" />
        
        <header className="sticky top-0 z-20 glass-panel border-b border-white/5 px-8 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors">
              <ArrowLeft size={20} />
            </Link>
            <div className="flex flex-col">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Code2 size={20} className="text-primary" />
                {repository.name || repository.fullName || 'Repository'}
              </h2>
              <p className="text-xs text-zinc-500">{repository.cloneUrl}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={handleClearCache}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 transition-all font-medium text-sm"
            >
              <RefreshCw size={16} /> Clear Cache
            </button>
            <button 
              onClick={handleDeleteRepo}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all font-medium text-sm"
            >
              <Trash2 size={16} /> Delete Repo
            </button>
          </div>
        </header>

        <div className="p-8 max-w-5xl mx-auto space-y-8">
          
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">Pull Requests</h3>
            <div className="text-sm text-zinc-500">{pullRequests.length} total PRs</div>
          </div>

          <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
            <div className="divide-y divide-white/5">
              {pullRequests.length === 0 ? (
                <div className="p-12 text-center text-zinc-500 flex flex-col items-center gap-4">
                  <GitPullRequest size={48} className="text-zinc-800" />
                  <p>No pull requests analyzed yet for this repository.</p>
                </div>
              ) : (
                pullRequests.map((pr: PullRequest) => (
                  <Link href={`/prs/${pr.id}`} key={pr.id} className="p-6 flex items-center justify-between hover:bg-white/[0.02] transition-colors group cursor-pointer block">
                    <div className="flex items-start gap-4">
                      <div className="mt-1 w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center shrink-0">
                        <GitPullRequest size={20} className="text-purple-500" />
                      </div>
                      <div>
                        <div className="flex items-center gap-3">
                          <h4 className="font-medium text-lg group-hover:text-primary transition-colors">{pr.title}</h4>
                          <span className={`text-xs px-2.5 py-0.5 rounded-full border ${getStatusColor(pr.status)}`}>
                            {pr.status}
                          </span>
                        </div>
                        <p className="text-sm text-zinc-400 mt-1 flex items-center gap-3">
                          <span className="font-mono text-xs bg-white/5 px-2 py-0.5 rounded text-zinc-300">#{pr.prNumber}</span>
                          <span>by {pr.author}</span>
                          <span className="w-1 h-1 rounded-full bg-zinc-600" />
                          <span className="flex items-center gap-1">
                            <Clock size={14} /> 
                            {new Date(pr.createdAt).toLocaleDateString()}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      {(pr._count?.findings ?? 0) > 0 && (
                        <div className="flex items-center gap-2 text-red-400 bg-red-400/10 px-3 py-1.5 rounded-lg text-sm font-medium border border-red-400/20">
                          <AlertCircle size={16} />
                          {pr._count?.findings} Findings
                        </div>
                      )}
                      {(pr._count?.findings ?? 0) === 0 && pr.status === 'COMPLETED' && (
                        <div className="flex items-center gap-2 text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-lg text-sm font-medium border border-emerald-400/20">
                          <CheckCircle2 size={16} />
                          Clean
                        </div>
                      )}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
