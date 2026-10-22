import { Router } from 'express';
import { PROVIDER_PRESETS, loadSettings, publicSettings, saveSettings } from '../services/settings.js';
import { LlmNotConfiguredError, listModels, pickChatModel, testCandidates, testConnection } from '../services/llm.js';

export const settings = Router();

settings.get('/', (_req, res) => {
  res.json({ settings: publicSettings(loadSettings()), presets: PROVIDER_PRESETS });
});

settings.put('/', (req, res) => {
  const { provider, baseUrl, model, apiKey } = req.body ?? {};
  const saved = saveSettings({ provider, baseUrl, model, apiKey: typeof apiKey === 'string' ? apiKey.trim() : undefined });
  res.json({ settings: publicSettings(saved), presets: PROVIDER_PRESETS });
});

/** Test the values currently in the form (saved or not); on success they are saved. */
settings.post('/test', async (req, res) => {
  const { provider, baseUrl, model, apiKey } = req.body ?? {};
  const form = { provider, baseUrl, model, apiKey: typeof apiKey === 'string' ? apiKey.trim() : undefined };
  try {
    const reply = await testConnection(form);
    const saved = saveSettings(form);
    res.json({ ok: true, reply, settings: publicSettings(saved) });
  } catch (e) {
    // Model retired/renamed (404) or too slow: try the best current models available to this key.
    const first = e as Error & { status?: number };
    const timedOut = /timed out|timeout/i.test(first.message);
    // Retired (404), busy / overloaded (429, 500, 502, 503, 504) or too slow: other models usually work.
    const retryable = first.status === 404 || first.status === 429 || (first.status !== undefined && first.status >= 500) || timedOut;
    if (retryable) {
      let models: string[] = [];
      try {
        models = await listModels(form);
      } catch {
        /* key cannot list models — report the original error */
      }
      const why = (err: unknown) => {
        const e2 = err as Error & { status?: number };
        if (/timed out/i.test(e2.message)) return 'timed out';
        if (e2.status === 404) return 'not available';
        if (e2.status === 429) return 'no free quota right now';
        if (e2.status && e2.status >= 500) return 'Google busy (' + e2.status + ')';
        return String(e2.status ?? e2.message);
      };
      const tried: string[] = [`${form.model ?? '(none)'}: ${why(first)}`];
      // Try the best candidates at the same time (≤ ~40 s in total) and keep the best-ranked one that answers.
      const candidates = testCandidates(models, form.model);
      const results = await Promise.allSettled(candidates.map((model) => testConnection({ ...form, model })));
      const winner = results.findIndex((x) => x.status === 'fulfilled');
      if (winner >= 0) {
        const model = candidates[winner];
        const saved = saveSettings({ ...form, model });
        res.json({
          ok: true,
          reply: (results[winner] as PromiseFulfilledResult<string>).value,
          settings: publicSettings(saved),
          note: `"${form.model ?? ''}" did not work for this key (${why(first)}), so "${model}" was selected. You can change it in the Model list.`,
          models,
        });
        return;
      }
      results.forEach((x, i) => tried.push(`${candidates[i]}: ${x.status === 'rejected' ? why(x.reason) : '?'}`));
      if (models.length) {
        res.json({
          ok: false,
          models,
          error: `Your key works (it can see ${models.length} models), but none of the models answered successfully. Tried: ${tried.join('; ')}. Google's free tier may be busy — wait a minute and click Test again, or click “Load models” and pick a “flash-lite” model.`,
        });
        return;
      }
    }
    res.json({ ok: false, error: friendlyAiError(first) });
  }
});

/** Models available for the key in the form. */
settings.post('/models', async (req, res) => {
  const { provider, baseUrl, model, apiKey } = req.body ?? {};
  try {
    const models = await listModels({ provider, baseUrl, model, apiKey: typeof apiKey === 'string' ? apiKey.trim() : undefined });
    res.json({ ok: true, models, suggested: pickChatModel(models, model) });
  } catch (e) {
    res.json({ ok: false, error: friendlyAiError(e as Error) });
  }
});

function friendlyAiError(e: Error & { status?: number }) {
  if (e instanceof LlmNotConfiguredError) return 'Paste your API key in the API key field above (and check Base URL and Model), then click Test connection.';
  if (e.status === 401 || e.status === 403 || /api key|unauthori[sz]ed|permission/i.test(e.message)) {
    return `The provider rejected the API key — check it was copied completely and belongs to the selected provider. (${e.message})`;
  }
  if (e.status === 404 || /model.*(not found|does not exist|not supported)|unknown model/i.test(e.message)) {
    return `The model name was not found for this provider — check the Model field. (${e.message})`;
  }
  if (e.status === 400) {
    return `The provider refused the request (400). With Google Gemini this almost always means the API key is not valid — copy it again from aistudio.google.com/apikey (it starts with "AIza") and make sure the Gemini provider is selected. (${e.message})`;
  }
  if (/timed out|timeout/i.test(e.message) || e.name === 'APIConnectionTimeoutError') {
    return 'The provider did not answer within 40 seconds. Try again; if it keeps happening, click “Load models” and choose a “flash” / “lite” model, or check your internet / firewall.';
  }
  if (e.status === 503 || e.status === 500 || e.status === 502 || e.status === 504) {
    return `Google's servers are busy right now (${e.status} — "model overloaded"). This is temporary and common on the free tier: wait a minute and click Test again.`;
  }
  if (e.status === 429) {
    return `Google/the provider says this key has no free quota left for this model right now (429). Wait a minute and retry, or click “Load models” and pick another model (a “flash-lite” model often has more free quota). (${e.message.slice(0, 200)})`;
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|Connection error/i.test(e.message)) return `Could not reach the provider at the Base URL — check your internet connection (or that Ollama is running). (${e.message})`;
  return e.message;
}
