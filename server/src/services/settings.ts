import fs from 'node:fs';
import path from 'node:path';
import type { LlmSettings } from '../../../shared/types.js';
import { WORKSPACE } from './paths.js';

export interface StoredSettings {
  provider: LlmSettings['provider'];
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const PROVIDER_PRESETS: Record<LlmSettings['provider'], { baseUrl: string; model: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-flash-latest' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  custom: { baseUrl: '', model: '' },
};

const FILE = path.join(WORKSPACE, 'settings.json');

function guessProvider(url: string): LlmSettings['provider'] {
  for (const [k, v] of Object.entries(PROVIDER_PRESETS)) if (v.baseUrl && url.startsWith(v.baseUrl)) return k as LlmSettings['provider'];
  return 'custom';
}

export function loadSettings(): StoredSettings {
  if (fs.existsSync(FILE)) {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf8')) as StoredSettings;
    } catch {
      /* fall through to env defaults */
    }
  }
  const baseUrl = process.env.LLM_BASE_URL || PROVIDER_PRESETS.gemini.baseUrl;
  return {
    provider: guessProvider(baseUrl),
    baseUrl,
    model: process.env.LLM_MODEL || PROVIDER_PRESETS.gemini.model,
    apiKey: process.env.LLM_API_KEY || '',
  };
}

export function saveSettings(update: Partial<StoredSettings>): StoredSettings {
  const current = loadSettings();
  const next: StoredSettings = {
    ...current,
    ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)),
  };
  // An empty key in the form means "keep the existing key".
  if (update.apiKey === '') next.apiKey = current.apiKey;
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

export function publicSettings(s: StoredSettings): LlmSettings {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    hasApiKey: Boolean(s.apiKey) || s.provider === 'ollama',
    apiKeyHint: s.apiKey ? `••••${s.apiKey.slice(-4)}` : undefined,
  };
}
