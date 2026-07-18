"use client";

import { Activity, Code2, GitPullRequest, LogOut, Settings, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "../../lib/api";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RepositoriesPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch (e) {}
    }

    async function loadData() {
      try {
        const reposData = await fetchWithAuth('/repos');
        setRepos(reposData);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    router.push('/login');
  };

  const handleDeleteRepo = async (repoId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this repository? This will permanently delete all associated PRs and findings.')) {
      return;
    }
    try {
      await fetchWithAuth(`/repos/${repoId}`, { method: 'DELETE' });
      setRepos(repos.filter(r => r.id !== repoId));
    } catch (err) {
      alert('Failed to delete repository');
      console.error(err);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-[#09090b] text-white">Loading repositories...</div>;
  }

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
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px] -z-10 pointer-events-none" />
        
        <header className="sticky top-0 z-20 glass-panel border-b border-white/5 px-8 py-4 flex items-center">
          <h2 className="text-xl font-semibold">Repositories</h2>
        </header>

        <div className="p-8 max-w-5xl mx-auto space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {repos.length === 0 ? (
              <div className="col-span-full p-12 glass-panel rounded-2xl border border-white/5 text-center text-zinc-500 flex flex-col items-center gap-4">
                <Code2 size={48} className="text-zinc-800" />
                <p>No repositories tracked yet. Trigger a PR review to add one.</p>
              </div>
            ) : (
              repos.map(repo => (
                <div 
                  key={repo.id} 
                  onClick={() => router.push(`/repos/${repo.id}`)}
                  className="glass-panel p-6 rounded-2xl border border-white/5 hover:border-primary/50 hover:bg-white/[0.02] transition-all group relative block cursor-pointer"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                        <Code2 size={20} className="text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-lg group-hover:text-primary transition-colors">{repo.name || repo.fullName}</h3>
                        <p className="text-xs text-zinc-500">{repo.defaultBranch}</p>
                      </div>
                    </div>
                    <button 
                      onClick={(e) => handleDeleteRepo(repo.id, e)}
                      className="text-zinc-500 hover:text-red-400 p-2 rounded-lg hover:bg-red-400/10 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  
                  <div className="flex items-center justify-between text-sm mt-6 pt-4 border-t border-white/5">
                    <div className="flex items-center gap-2 text-zinc-400">
                      <GitPullRequest size={16} />
                      {repo._count?.pullRequests || 0} PRs Analyzed
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
