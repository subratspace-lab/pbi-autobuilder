import { Router } from 'express';
import { PROVIDER_PRESETS, loadSettings, publicSettings, saveSettings } from '../services/settings.js';
import { testConnection } from '../services/llm.js';

export const settings = Router();

settings.get('/', (_req, res) => {
  res.json({ settings: publicSettings(loadSettings()), presets: PROVIDER_PRESETS });
});

settings.put('/', (req, res) => {
  const { provider, baseUrl, model, apiKey } = req.body ?? {};
  const saved = saveSettings({ provider, baseUrl, model, apiKey: typeof apiKey === 'string' ? apiKey.trim() : undefined });
  res.json({ settings: publicSettings(saved), presets: PROVIDER_PRESETS });
});

settings.post('/test', async (_req, res) => {
  try {
    const reply = await testConnection();
    res.json({ ok: true, reply });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
});
