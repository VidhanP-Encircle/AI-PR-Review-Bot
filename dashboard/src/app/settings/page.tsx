"use client";

import { Activity, Code2, GitPullRequest, LogOut, Settings, ShieldAlert, Key } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch (e) {}
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    router.push('/login');
  };

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
          <Link href="/" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors">
            <Activity size={18} /> Dashboard
          </Link>
          <Link href="/repos" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 font-medium transition-colors">
            <GitPullRequest size={18} /> Repositories
          </Link>
          <Link href="/settings" className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 text-zinc-100 font-medium transition-colors">
            <Settings size={18} className="text-primary" /> Settings
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
      <main className="flex-1 overflow-y-auto relative p-8">
        <header className="mb-8">
          <h2 className="text-2xl font-bold">Settings & Integrations</h2>
          <p className="text-zinc-400 mt-1">Configure your AI Review Bot and GitHub connections.</p>
        </header>

        <div className="max-w-4xl space-y-6">
          {/* GitHub App Setup Guide */}
          <div className="glass-panel rounded-2xl p-8 border border-white/5">
            <div className="flex items-center gap-3 mb-6 border-b border-white/5 pb-4">
              <div className="p-3 bg-primary/10 rounded-xl text-primary">
                <Key size={24} />
              </div>
              <div>
                <h3 className="text-xl font-semibold">GitHub App Integration (Private Repositories)</h3>
                <p className="text-zinc-400 text-sm">Follow these instructions to connect private repositories using a free GitHub App.</p>
              </div>
            </div>

            <div className="space-y-6 text-sm text-zinc-300">
              <p>
                To enable the AI Reviewer to access private repositories, you must create a GitHub App in your developer settings. This is 100% free and provides a secure way for the bot to interact with your code.
              </p>

              <ol className="list-decimal list-inside space-y-4">
                <li>
                  <strong>Create a new GitHub App:</strong> Go to your GitHub Profile &gt; Settings &gt; Developer settings &gt; GitHub Apps, and click <strong>New GitHub App</strong>.
                </li>
                <li>
                  <strong>Configure Permissions:</strong>
                  <ul className="list-disc list-inside ml-6 mt-2 space-y-1 text-zinc-400">
                    <li>Repository contents: <strong>Read-only</strong> (to clone the code)</li>
                    <li>Pull requests: <strong>Read & write</strong> (to read PR diffs and post review comments)</li>
                    <li>Metadata: <strong>Read-only</strong> (default)</li>
                  </ul>
                </li>
                <li>
                  <strong>Configure Webhooks:</strong>
                  <ul className="list-disc list-inside ml-6 mt-2 space-y-1 text-zinc-400">
                    <li>Webhook URL: <code className="bg-zinc-800 px-1 py-0.5 rounded text-primary">https://your-domain.com/api/v1/webhooks/github</code></li>
                    <li>Webhook Secret: Generate a random string and put it here.</li>
                    <li>Subscribe to events: <strong>Pull request</strong>.</li>
                  </ul>
                </li>
                <li>
                  <strong>Generate a Private Key:</strong> Scroll to the bottom of the App settings and click <strong>Generate a private key</strong>. This will download a `.pem` file to your computer.
                </li>
                <li>
                  <strong>Update `.env` file:</strong> Open the `.env` file in the root of the AI Review Bot repository and add the following variables:
                  <pre className="bg-zinc-900 border border-white/10 p-4 rounded-lg mt-2 overflow-x-auto text-zinc-300">
GITHUB_APP_ID=your_app_id_here
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
                  </pre>
                  <em className="text-xs text-zinc-500 mt-1 block">Note: The private key must be wrapped in quotes and newlines replaced with \n</em>
                </li>
                <li>
                  <strong>Install the App:</strong> On the left sidebar of your GitHub App settings, click "Install App" and install it on the organizations or repositories you want the bot to review.
                </li>
              </ol>

              <div className="mt-8 p-4 bg-primary/5 border border-primary/20 rounded-lg flex items-start gap-3">
                <ShieldAlert size={20} className="text-primary mt-0.5 shrink-0" />
                <p className="text-primary-light">
                  Once the app is installed and the environment variables are set, the bot will automatically authenticate using the GitHub App credentials. No further action is required!
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
