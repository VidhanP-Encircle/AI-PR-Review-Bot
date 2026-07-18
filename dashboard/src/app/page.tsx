"use client";

import { Activity, Code2, GitPullRequest, LogOut, Search, Settings, ShieldAlert, CheckCircle2 } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from "recharts";
import { useSession, signOut } from "next-auth/react";
import { fetchWithAuth } from "../lib/api";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, X, Loader2 } from "lucide-react";

import type { User, Repo, Stats } from '../types';

const getSeverityColor = (name: string) => {
  const normalized = name.toLowerCase();
  if (normalized.includes('critical')) return '#ef4444';
  if (normalized.includes('high')) return '#f97316';
  if (normalized.includes('medium')) return '#eab308';
  if (normalized.includes('low')) return '#3b82f6';
  return '#8b5cf6';
};

export default function Dashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const { data: session, status } = useSession();
  const user = session?.user;
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [prUrl, setPrUrl] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [triggerMessage, setTriggerMessage] = useState('');

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
      return;
    }
    
    if (status === 'authenticated') {
      async function loadData() {
        try {
          const [statsData, reposData] = await Promise.all([
            fetchWithAuth('/dashboard/stats'),
            fetchWithAuth('/repos')
          ]);
          setStats(statsData as Stats);
          setRepos(reposData as Repo[]);
        } catch (err: unknown) {
          console.error(err);
        } finally {
          setLoading(false);
        }
      }
      loadData();
    }
  }, [status, router]);

  const handleLogout = async () => {
    await signOut({ redirect: false });
    router.push('/login');
  };

  const handleTriggerReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prUrl) return;
    
    setTriggering(true);
    setTriggerMessage('');
    try {
      const res = await fetchWithAuth('/dashboard/trigger', {
        method: 'POST',
        body: JSON.stringify({ url: prUrl })
      });
      setTriggerMessage(res.message || 'Review enqueued successfully! It will appear shortly.');
      setPrUrl('');
      
      // Refresh repos list
      const reposData = await fetchWithAuth('/repos');
      setRepos(reposData);
      
      setTimeout(() => {
        setIsModalOpen(false);
        setTriggerMessage('');
      }, 3000);
    } catch (err: unknown) {
      setTriggerMessage(err instanceof Error ? err.message : 'Failed to trigger review');
    } finally {
      setTriggering(false);
    }
  };

  if (loading || status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-[#09090b] text-white">Loading telemetry...</div>;
  }

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-100 font-sans selection:bg-primary/30">
      
      {/* SIDEBAR */}
      <aside className="w-64 border-r border-white/5 bg-black/20 backdrop-blur-xl flex flex-col z-10 hidden md:flex">
        <div className="p-6">
          <div className="flex items-center gap-3 text-primary font-bold text-xl tracking-tight">
            <div className="w-8 h-8 rounded-lg bg-primary/20 border border-primary/50 flex items-center justify-center">
              <Code2 size={18} className="text-primary-light" />
            </div>
            AI Reviewer
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1">
          <a href="#" className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 text-zinc-100 font-medium transition-colors">
            <Activity size={18} className="text-primary" /> Dashboard
          </a>
          <Link href="/repos" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors">
            <GitPullRequest size={18} /> Repositories
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

        <header className="sticky top-0 z-20 glass-panel border-b border-white/5 px-8 py-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Overview</h2>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input 
              type="text" 
              placeholder="Search repositories, PRs..." 
              className="bg-zinc-900/50 border border-white/10 rounded-full pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary w-64 transition-all"
            />
          </div>
          <button 
            onClick={() => setIsModalOpen(true)}
            className="ml-4 flex items-center gap-2 bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Plus size={18} /> New Review
          </button>
        </header>

        <div className="p-8 max-w-7xl mx-auto space-y-8">
          
          {/* STATS ROW */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard title="Total Repositories" value={stats?.totalRepositories || 0} icon={<Code2 size={20} />} color="from-blue-500/20 to-blue-500/0" iconColor="text-blue-400" />
            <StatCard title="Analyzed PRs" value={stats?.totalPullRequests || 0} icon={<GitPullRequest size={20} />} color="from-purple-500/20 to-purple-500/0" iconColor="text-purple-400" />
            <StatCard title="Security Findings" value={stats?.totalFindings || 0} icon={<ShieldAlert size={20} />} color="from-red-500/20 to-red-500/0" iconColor="text-red-400" />
            <StatCard title="Inference Cost" value={`$${(stats?.totalCostUsd || 0).toFixed(4)}`} icon={<Activity size={20} />} color="from-emerald-500/20 to-emerald-500/0" iconColor="text-emerald-400" />
          </div>

          {/* CHARTS ROW */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Area Chart */}
            <div className="lg:col-span-2 glass-panel rounded-2xl p-6 border border-white/5 relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              <h3 className="text-sm font-medium text-zinc-400 mb-6 flex items-center gap-2">
                <Activity size={16} /> Token Usage & Cost (Last 7 Days)
              </h3>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats?.costData || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="name" stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `$${value}`} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                      itemStyle={{ color: '#e4e4e7' }}
                    />
                    <Area type="monotone" dataKey="cost" stroke="#8b5cf6" strokeWidth={3} fillOpacity={1} fill="url(#colorCost)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Bar Chart */}
            <div className="glass-panel rounded-2xl p-6 border border-white/5">
              <h3 className="text-sm font-medium text-zinc-400 mb-6 flex items-center gap-2">
                <ShieldAlert size={16} /> Findings by Severity
              </h3>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats?.severityData || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="name" stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      cursor={{ fill: '#27272a', opacity: 0.4 }}
                      contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                      itemStyle={{ color: '#e4e4e7' }}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {
                        stats?.severityData?.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={getSeverityColor(entry.name)} />
                        ))
                      }
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            
          </div>

          {/* RECENT REPOS */}
          <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <h3 className="font-medium">Active Repositories</h3>
            </div>
            <div className="divide-y divide-white/5">
              {repos.length === 0 ? (
                <div className="p-6 text-center text-zinc-500">No repositories found. Ensure webhooks are receiving data.</div>
              ) : (
                repos.map((repo: Repo) => (
                  <Link href={`/repos/${repo.id}`} key={repo.id} className="p-6 flex items-center justify-between hover:bg-white/[0.02] transition-colors group cursor-pointer">
                      <div className="flex items-center gap-4 transition-transform duration-300 group-hover:translate-x-1">
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
                        <Code2 size={20} className="text-blue-500" />
                      </div>
                      <div>
                        <h4 className="font-medium group-hover:text-primary transition-colors">{repo.name}</h4>
                        <p className="text-sm text-zinc-500 flex items-center gap-2 mt-1">
                          <span>{repo.cloneUrl}</span>
                          <span className="w-1 h-1 rounded-full bg-zinc-600" />
                          <span>{repo._count?.pullRequests || 0} PRs analyzed</span>
                        </p>
                      </div>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

        </div>

        {/* TRIGGER MODAL */}
        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-lg p-6 shadow-2xl relative">
              <button 
                onClick={() => setIsModalOpen(false)}
                className="absolute top-4 right-4 text-zinc-400 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
              
              <h3 className="text-xl font-semibold mb-2">Trigger AI Review</h3>
              <p className="text-zinc-400 text-sm mb-6">
                Paste a public GitHub Pull Request URL to run an instant AI review. The results will be visualized here.
              </p>

              <form onSubmit={handleTriggerReview} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">GitHub PR URL</label>
                  <input
                    type="url"
                    required
                    value={prUrl}
                    onChange={(e) => setPrUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo/pull/123"
                    className="w-full bg-zinc-950 border border-white/10 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                
                {triggerMessage && (
                  <div className={`p-3 rounded-lg text-sm ${triggerMessage.includes('Failed') ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                    {triggerMessage}
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={triggering || !prUrl}
                    className="flex items-center gap-2 bg-primary hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
                  >
                    {triggering ? <Loader2 size={18} className="animate-spin" /> : <GitPullRequest size={18} />}
                    {triggering ? 'Analyzing...' : 'Run Review'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

function StatCard({ title, value, icon, color, iconColor }: { title: string, value: string | number, icon: React.ReactNode, color: string, iconColor: string }) {
  return (
    <div className="glass-panel rounded-2xl p-6 relative overflow-hidden group hover:-translate-y-1 hover:shadow-2xl transition-all duration-300 cursor-default">
      <div className={`absolute inset-0 bg-gradient-to-b ${color} opacity-50`} />
      <div className="relative z-10 flex justify-between items-start">
        <div>
          <p className="text-zinc-400 text-sm font-medium mb-1">{title}</p>
          <h4 className="text-3xl font-bold tracking-tight">{value}</h4>
        </div>
        <div className={`p-3 rounded-xl bg-white/5 ${iconColor}`}>
          {icon}
        </div>
      </div>
    </div>
  );
}
