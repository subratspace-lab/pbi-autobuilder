import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, PlugZap, Save, XCircle } from 'lucide-react';
import { api } from '../api/client';
import { useStore } from '../store/projectStore';
import { Notice, PageHeader, Spinner } from '../components/ui';

const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini', badge: 'Recommended · free tier', keyUrl: 'https://aistudio.google.com/apikey', note: 'Large context, strong at DAX & M, JSON output.' },
  { id: 'groq', name: 'Groq', badge: 'Free tier · very fast', keyUrl: 'https://console.groq.com/keys', note: 'Llama 3.3 70B. Per-minute rate limits.' },
  { id: 'openrouter', name: 'OpenRouter', badge: 'Free models', keyUrl: 'https://openrouter.ai/keys', note: 'Pick any ":free" model.' },
  { id: 'ollama', name: 'Ollama (offline)', badge: 'Private · runs locally', keyUrl: 'https://ollama.com/download', note: 'Needs a strong PC (16 GB+ RAM, 6 GB+ GPU). Run: ollama pull qwen2.5-coder:7b' },
  { id: 'custom', name: 'Custom', badge: 'OpenAI-compatible', keyUrl: '', note: 'Any endpoint that speaks the OpenAI chat API.' },
] as const;

export function SettingsPage() {
  const { run, busy, loadSettings, toast } = useStore();
  const [presets, setPresets] = useState<Record<string, { baseUrl: string; model: string }>>({});
  const [form, setForm] = useState({ provider: 'gemini', baseUrl: '', model: '', apiKey: '' });
  const [keyHint, setKeyHint] = useState<string | undefined>();
  const [test, setTest] = useState<{ ok: boolean; reply?: string; error?: string } | null>(null);

  useEffect(() => {
    void run('settings', async () => {
      const res = await api.settings();
      setPresets(res.presets);
      setForm({ provider: res.settings.provider, baseUrl: res.settings.baseUrl, model: res.settings.model, apiKey: '' });
      setKeyHint(res.settings.apiKeyHint);
    });
  }, [run]);

  const choose = (provider: string) => {
    const p = presets[provider];
    setForm((f) => ({ ...f, provider, baseUrl: p?.baseUrl || f.baseUrl, model: p?.model || f.model }));
    setTest(null);
  };

  const save = async () => {
    const res = await run('save', () => api.saveSettings(form));
    if (res) {
      setKeyHint(res.settings.apiKeyHint);
      setForm((f) => ({ ...f, apiKey: '' }));
      await loadSettings();
      toast('success', 'Settings saved');
    }
  };

  const current = PROVIDERS.find((p) => p.id === form.provider);

  return (
    <>
      <PageHeader title="AI provider" subtitle="Any free OpenAI-compatible model works. The key is stored only on this computer (workspace/settings.json) and is never sent to the browser." />

      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => choose(p.id)}
            className={`card p-4 text-left transition ${form.provider === p.id ? 'border-brand-500 ring-2 ring-brand-100' : 'hover:border-slate-300'}`}
          >
            <div className="font-semibold text-slate-900">{p.name}</div>
            <div className="mt-0.5 text-xs font-medium text-violet-600">{p.badge}</div>
            <div className="mt-2 text-xs text-slate-500">{p.note}</div>
          </button>
        ))}
      </div>

      <div className="card mt-6 max-w-3xl space-y-4 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label">Base URL</label>
            <input className="input font-mono text-xs" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </div>
          <div>
            <label className="label">Model</label>
            <input className="input font-mono text-xs" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label">API key {keyHint && <span className="normal-case text-slate-400">(saved: {keyHint} — leave empty to keep)</span>}</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="password"
                autoComplete="off"
                className="input pl-9"
                placeholder={form.provider === 'ollama' ? 'Not needed for Ollama' : 'Paste your free API key'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </div>
            {current?.keyUrl && (
              <a className="btn-secondary" href={current.keyUrl} target="_blank" rel="noreferrer">
                Get a key <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={save} disabled={busy.save}>
            {busy.save ? <Spinner /> : <Save className="h-4 w-4" />} Save
          </button>
          <button className="btn-secondary" disabled={busy.test} onClick={async () => setTest((await run('test', () => api.testSettings())) ?? null)}>
            {busy.test ? <Spinner /> : <PlugZap className="h-4 w-4" />} Test connection
          </button>
          {test &&
            (test.ok ? (
              <span className="flex items-center gap-1 text-sm text-emerald-600">
                <CheckCircle2 className="h-4 w-4" /> Connected — model replied “{test.reply}”
              </span>
            ) : (
              <span className="flex items-center gap-1 text-sm text-red-600">
                <XCircle className="h-4 w-4" /> {test.error}
              </span>
            ))}
        </div>
      </div>

      <div className="mt-6 max-w-3xl">
        <Notice tone="blue" title="What is sent to the AI?">
          Only column names, data-quality statistics, about 15 sample rows per table and your project brief — never the full dataset. Free cloud tiers may use
          prompts to improve their models; use Ollama if the data is confidential. Every step also has a <b>rules</b> mode that works with no AI at all.
        </Notice>
      </div>
    </>
  );
}
