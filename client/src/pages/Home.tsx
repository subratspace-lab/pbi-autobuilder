import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FlaskConical, FolderPlus, Trash2 } from 'lucide-react';
import type { ProjectSummary } from '@shared/types';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { PageHeader, Spinner } from '../components/ui';
import { STEPS } from '../components/Layout';

export function HomePage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState('');
  const { run, busy, setProject } = useStore();
  const navigate = useNavigate();

  const refresh = () => run('list', async () => setProjects(await api.projects()));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (sample = false) => {
    const p = await run('create', async () => {
      const project = await api.createProject(sample ? 'Superstore Sales (sample)' : name || 'Untitled project');
      if (!sample) return project;
      return api.loadSample(project.id);
    });
    if (p) {
      setProject(p);
      navigate(`/p/${p.id}/upload`);
    }
  };

  return (
    <>
      <PageHeader
        title="Turn raw data into a Power BI dashboard"
        subtitle="Upload messy data and the project brief. The app profiles the data, understands the business, writes the Power Query cleaning steps, designs the star schema, writes the DAX measures and lays out the dashboard — then exports a Power BI project you open and save as .pbix."
      />

      <div className="mb-8 grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="card p-5">
          <h2 className="mb-3 font-semibold text-slate-900">New project</h2>
          <div className="flex gap-2">
            <input
              className="input"
              placeholder="e.g. Sales Performance Dashboard"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button className="btn-primary shrink-0" onClick={() => create()} disabled={busy.create}>
              {busy.create ? <Spinner /> : <FolderPlus className="h-4 w-4" />} Create
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {STEPS.map((s, i) => (
              <span key={s.path} className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                <s.icon className="h-3.5 w-3.5" /> {i + 1}. {s.label}
              </span>
            ))}
          </div>
        </div>
        <button className="card flex flex-col items-start p-5 text-left transition hover:border-brand-500" onClick={() => create(true)} disabled={busy.create}>
          <FlaskConical className="mb-2 h-6 w-6 text-violet-600" />
          <div className="font-semibold text-slate-900">Try the sample project</div>
          <p className="mt-1 text-sm text-slate-500">Messy retail sales export (1,800 rows) + a client brief. Great for a demo.</p>
        </button>
      </div>

      <h2 className="mb-3 font-semibold text-slate-900">Projects</h2>
      {!projects ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <p className="text-sm text-slate-500">No projects yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <div key={p.id} className="card group flex items-center justify-between p-4">
              <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/p/${p.id}/upload`)}>
                <div className="truncate font-medium text-slate-900">{p.name}</div>
                <div className="text-xs text-slate-500">
                  {p.tables} table(s) · updated {new Date(p.updatedAt).toLocaleString()}
                </div>
              </button>
              <div className="flex items-center gap-1">
                <button
                  className="btn-ghost p-2 opacity-0 group-hover:opacity-100"
                  title="Delete project"
                  onClick={async () => {
                    if (!confirm(`Delete "${p.name}" and its files?`)) return;
                    await run('delete', () => api.deleteProject(p.id));
                    void refresh();
                  }}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
                <ArrowRight className="h-4 w-4 text-slate-400" />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
