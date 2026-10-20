import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, Loader2, Sparkles, Wand2, X, XCircle } from 'lucide-react';
import { aiReady, useStore } from '../store/projectStore';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} />;
}

export function PageHeader({ step, title, subtitle, actions }: { step?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {step && <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand-600">{step}</div>}
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    blue: 'bg-brand-50 text-brand-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    violet: 'bg-violet-50 text-violet-700',
  };
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function TypeBadge({ type }: { type: string }) {
  const tone = { text: 'slate', number: 'blue', integer: 'blue', currency: 'green', date: 'violet', datetime: 'violet', boolean: 'amber' }[type] as
    | 'slate'
    | 'blue'
    | 'green'
    | 'violet'
    | 'amber';
  return <Badge tone={tone ?? 'slate'}>{type}</Badge>;
}

/** The "Suggest with AI" / "Rules" button pair used on every step. */
export function SuggestButtons({ onSuggest, busy, label = 'Suggest', hasExisting }: { onSuggest: (mode: 'ai' | 'rules') => void; busy?: boolean; label?: string; hasExisting?: boolean }) {
  const settings = useStore((s) => s.settings);
  const ready = aiReady(settings);
  const confirmReplace = (mode: 'ai' | 'rules') => {
    if (hasExisting && !window.confirm('This replaces the current version with a new suggestion. Continue?')) return;
    onSuggest(mode);
  };
  return (
    <div className="flex items-center gap-2">
      <button className="btn-secondary" disabled={busy} onClick={() => confirmReplace('rules')} title="Deterministic rules — no AI needed">
        <Wand2 className="h-4 w-4" /> {label} (rules)
      </button>
      {ready ? (
        <button className="btn-ai" disabled={busy} onClick={() => confirmReplace('ai')}>
          {busy ? <Spinner /> : <Sparkles className="h-4 w-4" />} {label} with AI
        </button>
      ) : (
        <Link to="/settings" className="btn-secondary border-dashed text-violet-700" title="Add a free API key to enable AI">
          <Sparkles className="h-4 w-4" /> Enable AI
        </Link>
      )}
      {busy && !ready && <Spinner />}
    </div>
  );
}

export function Notice({ tone = 'amber', title, items, children }: { tone?: 'amber' | 'red' | 'blue' | 'green'; title?: string; items?: string[]; children?: ReactNode }) {
  if (!children && !items?.length) return null;
  const styles = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-900',
    blue: 'border-brand-100 bg-brand-50 text-brand-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
  const Icon = tone === 'red' ? XCircle : tone === 'green' ? CheckCircle2 : tone === 'blue' ? Info : AlertTriangle;
  return (
    <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${styles[tone]}`}>
      <div className="flex gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          {title && <div className="font-semibold">{title}</div>}
          {children}
          {items && items.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {items.slice(0, 12).map((i, k) => (
                <li key={k}>{i}</li>
              ))}
              {items.length > 12 && <li>…and {items.length - 12} more</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-brand-50 p-3 text-brand-600">{icon}</div>
      <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useStore();
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`card flex gap-3 p-3 text-sm shadow-lg ${t.kind === 'error' ? 'border-red-200' : t.kind === 'success' ? 'border-emerald-200' : ''}`}
        >
          {t.kind === 'error' ? (
            <XCircle className="h-5 w-5 shrink-0 text-red-500" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
          ) : (
            <Info className="h-5 w-5 shrink-0 text-brand-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-800">{t.text}</div>
            {t.details && t.details.length > 0 && (
              <ul className="mt-1 max-h-40 list-disc overflow-auto pl-4 text-xs text-slate-500">
                {t.details.slice(0, 15).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
          <button className="text-slate-400 hover:text-slate-600" onClick={() => dismiss(t.id)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function formatValue(v: number | null | undefined, format?: string) {
  if (v === null || v === undefined) return '—';
  if (format?.includes('%')) return `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (abs >= 1e4) return `${(v / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
