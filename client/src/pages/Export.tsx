import { useEffect, useState } from 'react';
import { Download, ExternalLink, FolderOpen, PackageCheck } from 'lucide-react';
import { api, type ExportResult, type ExportStatus } from '../api/client';
import { useStore } from '../store/projectStore';
import { Notice, PageHeader, Spinner, formatValue } from '../components/ui';
import { NextStep } from '../components/Layout';

export function ExportPage() {
  const { project, setProject, run, busy, toast } = useStore();
  const [fileName, setFileName] = useState('');
  const [dataFolder, setDataFolder] = useState('');
  const [embedData, setEmbedData] = useState(true);
  const [liveSql, setLiveSql] = useState(true);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);

  const refreshStatus = async (id: string) => {
    try {
      setStatus(await api.exportStatus(id));
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    if (project?.id) void refreshStatus(project.id);
  }, [project?.id]);

  useEffect(() => {
    setFileName(project?.export.projectFileName || project?.name || '');
    setDataFolder(project?.export.dataFolder ?? '');
    setEmbedData(project?.export.embedData !== false);
    setLiveSql(project?.export.liveSql !== false);
  }, [project?.id, project?.export, project?.name]);
  if (!project) return null;

  const missing = [
    !project.tables.length && 'Upload data',
    !project.model && 'Build the data model',
    !project.measures.length && 'Create measures',
    !project.report && 'Design the dashboard',
  ].filter(Boolean) as string[];

  const doExport = async () => {
    const p = await run('patch', () => api.patchProject(project.id, { export: { projectFileName: fileName, dataFolder, embedData, liveSql } }));
    if (p) setProject(p);
    const res = await run('export', () => api.export(project.id));
    if (res) setResult(res);
    await refreshStatus(project.id);
  };

  const openPbi = async () => {
    const res = await run('open', () => api.openExport(project.id, 'pbip'));
    if (!res) return;
    toast(
      'success',
      res.method === 'powerbi' ? 'Opening in Power BI Desktop…' : 'Opening with the default app for .pbip files…',
      ['It can take 20–60 seconds to start. Then click “Refresh now” on the yellow bar.'],
    );
  };

  return (
    <>
      <PageHeader step="Step 7" title="Export the Power BI project" subtitle="Generates a Power BI Project (.pbip): Power Query cleaning, star-schema model, DAX measures, theme and the dashboard page — plus a README that explains every step for the demo." />
      {missing.length > 0 && <Notice tone="red" title="Not ready yet" items={missing} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section className="card space-y-4 p-5">
          <div>
            <label className="label">Project file name</label>
            <input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={embedData} onChange={(e) => setEmbedData(e.target.checked)} />
            <span className="text-sm">
              <span className="font-medium text-slate-900">Embed the data in the project (recommended for sharing)</span>
              <span className="block text-xs text-slate-500">
                Works on any PC — no files or paths to fix. Untick to read the files from a Data folder instead (better for very large or frequently updated data).
              </span>
            </span>
          </label>
          {project.tables.some((t) => t.kind === 'sql') && (
            <label className="flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50/60 p-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={liveSql} onChange={(e) => setLiveSql(e.target.checked)} />
              <span className="text-sm">
                <span className="font-medium text-slate-900">Keep SQL Server tables live</span>
                <span className="block text-xs text-slate-500">
                  Power BI connects to {[...new Set(project.tables.filter((t) => t.sql).map((t) => `${t.sql!.server} / ${t.sql!.database}`))].join(', ')} and
                  always refreshes the latest data (it asks for the login once). Untick to embed today's snapshot instead — for sharing with someone who has no access to the server.
                </span>
              </span>
            </label>
          )}
          <div className={embedData ? 'hidden' : ''}>
            <label className="label">Data folder used by Power BI (parameter “DataFolder”)</label>
            <input
              className="input font-mono text-xs"
              placeholder="empty = the Data folder inside the exported project (on this PC)"
              value={dataFolder}
              onChange={(e) => setDataFolder(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              Leave empty. On another PC, the bundled <code>Open in Power BI.cmd</code> sets this automatically to the extracted Data folder.
            </p>
          </div>
          <button className="btn-primary w-full py-3 text-base" disabled={missing.length > 0 || busy.export} onClick={doExport}>
            {busy.export ? <Spinner /> : <PackageCheck className="h-5 w-5" />} Generate Power BI project
          </button>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 font-semibold text-slate-900">Then, in Power BI Desktop</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
            <li>
              Install <b>Power BI Desktop</b> (free, Microsoft Store). On older versions enable <i>Options → Preview features → Power BI Project (.pbip) save option</i> and{' '}
              <i>PBIR format</i>.
            </li>
            <li>
              Sending it to someone? They must <b>extract the zip first</b> (right-click → Extract All), then open the <b>.pbip</b>
              {embedData ? '' : ' via Open in Power BI.cmd, which points the report at the Data folder on their PC'}. On this PC, use the button below.
            </li>
            <li>
              It first shows <b>(Blank)</b> and a yellow “needs to be manually refreshed” bar — that is normal. Click <b>Refresh now</b> once, then check row counts
              and totals against the table on this page.
            </li>
            <li>
              <b>File → Save as → .pbix</b> — one file to share and present.
            </li>
          </ol>
        </section>
      </div>

      {(result || status?.exists) && (
        <div className="mt-6 space-y-4">
          <Notice tone="green" title={result ? 'Project generated' : 'Last generated project'}>
            <code className="break-all text-xs">{result?.projectFile ?? status?.projectFile}</code>
          </Notice>
          <div className="flex flex-wrap items-center gap-2">
            <a className="btn-primary" href={api.downloadUrl(project.id)}>
              <Download className="h-4 w-4" /> Download .zip
            </a>
            <button className="btn-secondary" disabled={busy.open} onClick={openPbi}>
              {busy.open ? <Spinner /> : <ExternalLink className="h-4 w-4" />} Open in Power BI Desktop
            </button>
            <button className="btn-secondary" onClick={() => run('openFolder', () => api.openExport(project.id, 'folder'))}>
              <FolderOpen className="h-4 w-4" /> Open folder
            </button>
            {status && (
              <span className="text-xs text-slate-500">
                {status.powerBiDesktop ? '✓ Power BI Desktop found on this PC' : 'Power BI Desktop not detected — the file opens with its default app'}
              </span>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-4">
          <Notice title="Generation notes" items={result.warnings} />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="card p-4">
              <h3 className="mb-2 font-semibold text-slate-900">Expected row counts after refresh</h3>
              <table className="w-full text-sm">
                <tbody>
                  {result.rowChecks.map((r) => (
                    <tr key={r.table} className="border-b border-slate-100">
                      <td className="py-1.5">{r.table}</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{r.rows.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card p-4">
              <h3 className="mb-2 font-semibold text-slate-900">Expected measure totals (no filters)</h3>
              <table className="w-full text-sm">
                <tbody>
                  {result.measureChecks.map((m) => (
                    <tr key={m.name} className="border-b border-slate-100">
                      <td className="py-1.5">{m.name}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {m.value === null ? (
                          <span className="text-xs text-slate-400">{m.note}</span>
                        ) : (
                          <span className="font-semibold">{formatValue(m.value, project.measures.find((x) => x.name === m.name)?.formatString)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      <NextStep current="export" />
    </>
  );
}
