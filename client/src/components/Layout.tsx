import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  Brain,
  Check,
  Database,
  FolderOpen,
  LayoutDashboard,
  PackageCheck,
  Settings as SettingsIcon,
  Sigma,
  Sparkles,
  Upload,
  Wand2,
} from 'lucide-react';
import type { Project } from '@shared/types';
import { aiReady, useStore } from '../store/projectStore';
import { Spinner, Toasts } from './ui';

export const STEPS = [
  { path: 'upload', label: 'Upload', hint: 'Raw data + brief', icon: Upload, done: (p: Project) => p.tables.length > 0 },
  { path: 'profile', label: 'Understand', hint: 'Profile & business', icon: Brain, done: (p: Project) => Boolean(p.analysis) },
  { path: 'clean', label: 'Clean', hint: 'Power Query steps', icon: Wand2, done: (p: Project) => p.cleaning.some((c) => c.ops.length > 0) },
  { path: 'model', label: 'Model', hint: 'Star schema', icon: Database, done: (p: Project) => Boolean(p.model) },
  { path: 'measures', label: 'Measures', hint: 'DAX', icon: Sigma, done: (p: Project) => p.measures.length > 0 },
  { path: 'dashboard', label: 'Dashboard', hint: 'KPIs, charts, slicers', icon: LayoutDashboard, done: (p: Project) => Boolean(p.report) },
  { path: 'export', label: 'Export', hint: '.pbip → .pbix', icon: PackageCheck, done: () => false },
] as const;

function AiPill() {
  const settings = useStore((s) => s.settings);
  const ready = aiReady(settings);
  return (
    <Link
      to="/settings"
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${ready ? 'bg-white/10 text-white' : 'bg-amber-400/15 text-amber-200'}`}
      title="AI provider settings"
    >
      <Sparkles className="h-3.5 w-3.5" />
      <span className="truncate">{ready ? `${settings!.provider} · ${settings!.model}` : 'AI off — rules only'}</span>
    </Link>
  );
}

export function Layout() {
  const { id } = useParams();
  const { project, loadProject, loadSettings, busy } = useStore();

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  useEffect(() => {
    if (id) void loadProject(id);
  }, [id, loadProject]);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col bg-slate-900 text-slate-300">
        <Link to="/" className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-pbi text-slate-900">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">PBI AutoBuilder</div>
            <div className="text-[11px] text-slate-400">raw data → Power BI</div>
          </div>
        </Link>

        <nav className="flex-1 overflow-y-auto px-3">
          <NavLink to="/" end className={({ isActive }) => `mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5'}`}>
            <FolderOpen className="h-4 w-4" /> All projects
          </NavLink>

          {id && (
            <>
              <div className="mb-2 truncate px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {project?.name ?? (busy.project ? 'Loading…' : '')}
              </div>
              <ol className="space-y-0.5">
                {STEPS.map((s, i) => {
                  const done = project ? s.done(project) : false;
                  return (
                    <li key={s.path}>
                      <NavLink
                        to={`/p/${id}/${s.path}`}
                        className={({ isActive }) =>
                          `group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-brand-600 text-white' : 'hover:bg-white/5'}`
                        }
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                            done ? 'bg-emerald-500 text-white' : 'bg-white/10 text-slate-300'
                          }`}
                        >
                          {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium leading-tight">{s.label}</span>
                          <span className="block truncate text-[11px] leading-tight opacity-60">{s.hint}</span>
                        </span>
                      </NavLink>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </nav>

        <div className="space-y-2 border-t border-white/10 p-3">
          <AiPill />
          <NavLink to="/settings" className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5'}`}>
            <SettingsIcon className="h-4 w-4" /> Settings
          </NavLink>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-7xl px-8 py-8">
          {id && !project ? (
            <div className="flex items-center gap-2 text-slate-500">
              <Spinner /> Loading project…
            </div>
          ) : (
            <>
              <BackLink />
              <Outlet />
            </>
          )}
        </div>
      </main>
      <Toasts />
    </div>
  );
}

/** Back / Next buttons shown at the bottom of each step page. */
export function NextStep({ current }: { current: string }) {
  const { id } = useParams();
  const i = STEPS.findIndex((s) => s.path === current);
  const prev = STEPS[i - 1];
  const next = STEPS[i + 1];
  return (
    <div className="mt-8 flex items-center justify-between gap-3 border-t border-slate-200 pt-6">
      {prev ? (
        <Link to={`/p/${id}/${prev.path}`} className="btn-secondary">
          <ArrowLeft className="h-4 w-4" /> Back: {prev.label}
        </Link>
      ) : (
        <Link to="/" className="btn-secondary">
          <ArrowLeft className="h-4 w-4" /> All projects
        </Link>
      )}
      {next && (
        <Link to={`/p/${id}/${next.path}`} className="btn-primary">
          Next: {next.label} →
        </Link>
      )}
    </div>
  );
}

/** "← Back" link at the top of every page except the home page. */
function BackLink() {
  const { id } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (pathname === '/') return null;
  let label = 'Back';
  let to: string | null = null;
  if (id) {
    const step = pathname.split('/')[3];
    const i = STEPS.findIndex((s) => s.path === step);
    if (i > 0) {
      to = `/p/${id}/${STEPS[i - 1].path}`;
      label = `Back: ${STEPS[i - 1].label}`;
    } else {
      to = '/';
      label = 'All projects';
    }
  }
  return (
    <button
      className="mb-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-slate-500 transition hover:text-brand-600"
      onClick={() => (to ? navigate(to) : window.history.length > 1 ? navigate(-1) : navigate('/'))}
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </button>
  );
}
