import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Activity, ClipboardList, Globe, LayoutDashboard, LogOut, Menu, Server, Settings, Workflow } from 'lucide-react';
import { api } from './lib/api';
import { authClient } from './lib/auth';
import { msg, t, useLang } from './lib/i18n';
import { cx, Loading, ToastProvider } from './components/ui';
import { Logo } from './components/Logo';
import { LanguageSwitch } from './components/LanguageSwitch';
import LoginPage from './pages/Login';
import ResetPasswordPage from './pages/ResetPassword';
import DashboardPage from './pages/Dashboard';
import SitesPage from './pages/Sites';
import SiteDetailPage from './pages/SiteDetail';
import WorkflowsPage from './pages/Workflows';
import WorkflowEditorPage from './pages/WorkflowEditor';
import PlansPage from './pages/Plans';
import PlanEditorPage from './pages/PlanEditor';
import RunsPage from './pages/Runs';
import RunDetailPage from './pages/RunDetail';
import ComparePage from './pages/Compare';
import SystemPage from './pages/System';
import SettingsPage from './pages/Settings';

export interface Me {
  user: { id: string; name: string; email: string; twoFactorEnabled?: boolean | null };
  publicUrl: string;
  mcpAllowRun: boolean;
  limits: { maxVus: number; maxRate: number; maxDurationSec: number };
}

const NAV = [
  { to: '/', label: msg('Overview'), icon: LayoutDashboard, end: true },
  { to: '/sites', label: msg('Sites & benchmark'), icon: Globe },
  { to: '/workflows', label: msg('Workflows'), icon: Workflow },
  { to: '/plans', label: msg('Test plans'), icon: ClipboardList },
  { to: '/runs', label: msg('Runs'), icon: Activity },
  { to: '/system', label: msg('System resources'), icon: Server },
  { to: '/settings', label: msg('Settings & MCP'), icon: Settings },
];

function Shell({ me, onLogout, onRefresh }: { me: Me; onLogout: () => void; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  return (
    <div className="flex min-h-screen">
      <aside className={cx('fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-transform md:static md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <Logo className="size-8" />
          <div>
            <div className="text-sm font-semibold leading-tight">LoadLab</div>
            <div className="text-[10px] text-ink-3">{t('k6 load testing platform')}</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) => cx('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors', isActive ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
            >
              <n.icon className="size-4" />
              {t(n.label)}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-line px-4 py-3 text-xs text-ink-3">
          <LanguageSwitch />
          <div className="flex items-center justify-between gap-2">
            <span className="truncate" title={me.user.email}>
              {me.user.email}
            </span>
            <button
              className="inline-flex shrink-0 items-center gap-1 hover:text-ink"
              onClick={async () => {
                await authClient.signOut();
                onLogout();
                nav('/login');
              }}
            >
              <LogOut className="size-3.5" /> {t('Sign out')}
            </button>
          </div>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      <main className="min-w-0 flex-1">
        <div className="flex h-14 items-center border-b border-line px-4 md:hidden">
          <button onClick={() => setOpen(true)} aria-label={t('Menu')}>
            <Menu className="size-5" />
          </button>
          <span className="ml-3 text-sm font-semibold">LoadLab</span>
        </div>
        <div className="mx-auto max-w-[1400px] p-4 md:p-6">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/sites" element={<SitesPage />} />
            <Route path="/sites/:id" element={<SiteDetailPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/plans/:id" element={<PlanEditorPage me={me} />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/settings" element={<SettingsPage me={me} onChange={onRefresh} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function Root() {
  // Re-render the whole tree when the language changes
  useLang();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = () =>
    api
      .get<Me>('/api/me')
      .then(setMe)
      .catch(() => setMe(null));
  useEffect(() => {
    load();
    const h = () => setMe(null);
    window.addEventListener('ll:unauthorized', h);
    return () => window.removeEventListener('ll:unauthorized', h);
  }, []);

  if (me === undefined) return <Loading />;
  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage onLogin={load} />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/*" element={me ? <Shell me={me} onLogout={() => setMe(null)} onRefresh={load} /> : <Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </ToastProvider>
  );
}
