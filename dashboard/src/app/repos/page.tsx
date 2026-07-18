"use client";

import {
  Activity,
  Code2,
  GitPullRequest,
  LogOut,
  Settings,
  Trash2,
  Search,
  Filter,
  ArrowUpDown,
  Calendar,
} from "lucide-react";
import { useEffect, useState, useMemo } from "react";
import { fetchWithAuth } from "../../lib/api";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RepositoriesPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "prs" | "recent">("recent");

  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch (e) {}
    }

    async function loadData() {
      try {
        const reposData = await fetchWithAuth("/repos");
        setRepos(reposData);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const filteredAndSortedRepos = useMemo(() => {
    let filtered = repos;

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = repos.filter(
        (repo) =>
          (repo.name || repo.fullName || "").toLowerCase().includes(query) ||
          (repo.cloneUrl || "").toLowerCase().includes(query) ||
          (repo.defaultBranch || "").toLowerCase().includes(query),
      );
    }

    // Sort
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return (a.name || a.fullName || "").localeCompare(
            b.name || b.fullName || "",
          );
        case "prs":
          return (b._count?.pullRequests || 0) - (a._count?.pullRequests || 0);
        case "recent":
        default:
          return (
            new Date(b.updatedAt || 0).getTime() -
            new Date(a.updatedAt || 0).getTime()
          );
      }
    });
  }, [repos, searchQuery, sortBy]);

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    router.push("/login");
  };

  const handleDeleteRepo = async (repoId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      !confirm(
        "Are you sure you want to delete this repository? This will permanently delete all associated PRs and findings.",
      )
    ) {
      return;
    }
    try {
      await fetchWithAuth(`/repos/${repoId}`, { method: "DELETE" });
      setRepos(repos.filter((r) => r.id !== repoId));
    } catch (err) {
      alert("Failed to delete repository");
      console.error(err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#09090b] text-white">
        Loading repositories...
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-100 font-sans selection:bg-primary/30">
      {/* SIDEBAR */}
      <aside className="w-64 border-r border-white/5 bg-black/20 backdrop-blur-xl flex-col z-10 hidden md:flex">
        <div className="p-6">
          <Link
            href="/"
            className="flex items-center gap-3 text-primary font-bold text-xl tracking-tight hover:opacity-80 transition-opacity"
          >
            <div className="w-8 h-8 rounded-lg bg-primary/20 border border-primary/50 flex items-center justify-center">
              <Code2 size={18} className="text-primary-light" />
            </div>
            AI Reviewer
          </Link>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1">
          <Link
            href="/"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors"
          >
            <Activity size={18} /> Dashboard
          </Link>
          <Link
            href="/repos"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 text-zinc-100 font-medium transition-colors"
          >
            <GitPullRequest size={18} className="text-primary" /> Repositories
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors"
          >
            <Settings size={18} /> Settings
          </Link>
        </nav>

        <div className="p-4 border-t border-white/5">
          <div className="flex items-center gap-3 px-3 py-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold">
              {user?.email?.charAt(0).toUpperCase() || "U"}
            </div>
            <div className="flex-1 truncate">
              <p className="text-sm font-medium truncate">
                {user?.email || "User"}
              </p>
              <p className="text-xs text-zinc-500 capitalize">
                {user?.role || "Admin"}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition-colors text-sm font-medium"
          >
            <LogOut size={18} /> Sign Out
          </button>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 overflow-y-auto relative">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px] -z-10 pointer-events-none" />

        <header className="sticky top-0 z-20 glass-panel border-b border-white/5 px-8 py-4 flex items-center gap-4">
          <h2 className="text-xl font-semibold mr-4">Repositories</h2>

          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
              size={16}
            />
            <input
              type="text"
              placeholder="Search by name, URL, or branch..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-900/50 border border-white/10 rounded-full pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
            />
          </div>

          {/* Sort controls */}
          <div className="flex items-center gap-2 text-sm">
            <Filter size={14} className="text-zinc-500" />
            {(["recent", "name", "prs"] as const).map((option) => (
              <button
                key={option}
                onClick={() => setSortBy(option)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  sortBy === option
                    ? "bg-primary/20 text-primary border border-primary/30"
                    : "text-zinc-400 hover:text-zinc-200 border border-white/5 hover:bg-white/5"
                }`}
              >
                {option === "recent"
                  ? "Recent"
                  : option === "name"
                    ? "Name"
                    : "Most PRs"}
              </button>
            ))}
          </div>

          <div className="text-sm text-zinc-500 ml-auto">
            {filteredAndSortedRepos.length} of {repos.length} repos
          </div>
        </header>

        <div className="p-8 max-w-5xl mx-auto space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAndSortedRepos.length === 0 ? (
              <div className="col-span-full p-12 glass-panel rounded-2xl border border-white/5 text-center text-zinc-500 flex flex-col items-center gap-4">
                <Code2 size={48} className="text-zinc-800" />
                {searchQuery ? (
                  <p>
                    No repositories matching &quot;{searchQuery}&quot;. Try a
                    different search term.
                  </p>
                ) : (
                  <p>
                    No repositories tracked yet. Trigger a PR review to add one.
                  </p>
                )}
              </div>
            ) : (
              filteredAndSortedRepos.map((repo) => (
                <div
                  key={repo.id}
                  onClick={() => router.push(`/repos/${repo.id}`)}
                  className="glass-panel p-6 rounded-2xl border border-white/5 hover:border-primary/50 hover:bg-white/2 transition-all group relative block cursor-pointer"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                        <Code2 size={20} className="text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-lg group-hover:text-primary transition-colors">
                          {repo.name || repo.fullName}
                        </h3>
                        <p className="text-xs text-zinc-500">
                          {repo.defaultBranch}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleDeleteRepo(repo.id, e)}
                      className="text-zinc-500 hover:text-red-400 p-2 rounded-lg hover:bg-red-400/10 transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete repository"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-sm mt-6 pt-4 border-t border-white/5">
                    <div className="flex items-center gap-2 text-zinc-400">
                      <GitPullRequest size={16} />
                      {repo._count?.pullRequests || 0} PRs Analyzed
                    </div>
                    {repo.updatedAt && (
                      <div className="flex items-center gap-1 text-zinc-500 text-xs">
                        <Calendar size={12} />
                        {new Date(repo.updatedAt).toLocaleDateString()}
                      </div>
                    )}
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
