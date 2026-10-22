import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { z } from 'zod';
import { PROMPTS_DIR } from './paths.js';
import { loadSettings, type StoredSettings } from './settings.js';

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('No AI provider configured. Add a free API key on the Settings page (or use the rule-based suggestions).');
  }
}

/** Settings in use; `override` lets the Settings page test values that are not saved yet. */
interface Limits {
  timeout?: number;
  maxRetries?: number;
  /** Ask reasoning models to think briefly (quick checks). */
  lowEffort?: boolean;
}

function client(override?: Partial<StoredSettings>, limits: Limits = {}) {
  const stored = loadSettings();
  const s = { ...stored, ...Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined && v !== '')) } as StoredSettings;
  if (!s.baseUrl || !s.model || (!s.apiKey && s.provider !== 'ollama')) throw new LlmNotConfiguredError();
  return {
    model: s.model,
    isGemini: /generativelanguage.googleapis.com/i.test(s.baseUrl),
    api: new OpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey || 'ollama', timeout: limits.timeout ?? 180_000, maxRetries: limits.maxRetries ?? 2 }),
  };
}

export function loadPrompt(name: string, vars: Record<string, unknown>): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  });
}

/** Pull a JSON object out of a model reply (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI reply did not contain a JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

const SYSTEM =
  'You are a senior Power BI developer and business analyst. You answer ONLY with a single valid JSON object that matches the requested schema. No markdown, no commentary.';

async function complete(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  jsonMode: boolean,
  override?: Partial<StoredSettings>,
  limits?: Limits,
) {
  const { api, model, isGemini } = client(override, limits);
  const request = (lowEffort: boolean) =>
    api.chat.completions.create({
      model,
      messages,
      temperature: 0.2,
      // Gemini's OpenAI-compatible API accepts reasoning_effort; "low" keeps thinking models quick.
      ...(lowEffort ? { reasoning_effort: 'low' as const } : {}),
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    });
  const low = Boolean(limits?.lowEffort && isGemini);
  try {
    const res = await request(low);
    return res.choices[0]?.message?.content ?? '';
  } catch (e) {
    // A model that does not support reasoning_effort answers 400: retry without it.
    if (low && e instanceof OpenAI.APIError && e.status === 400) {
      const res = await request(false);
      return res.choices[0]?.message?.content ?? '';
    }
    // Real work (not quick checks): if the saved model is overloaded / out of quota / retired,
    // use the next best model this key can access for this request.
    const status = e instanceof OpenAI.APIError ? e.status : undefined;
    if (!limits && !override && status !== undefined && (status === 404 || status === 429 || status >= 500)) {
      for (const alt of await fallbackModels(model)) {
        try {
          const res = await client({ model: alt }).api.chat.completions.create({
            model: alt,
            messages,
            temperature: 0.2,
            ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
          });
          console.log(`[ai] ${model} answered ${status}; used ${alt} instead`);
          return res.choices[0]?.message?.content ?? '';
        } catch {
          /* try the next one */
        }
      }
    }
    throw e;
  }
}

/** Ask for JSON, validate with zod, and retry once with the validation error. */
export async function askJson<S extends z.ZodTypeAny>(prompt: string, schema: S): Promise<z.output<S>> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await complete(messages, true);
    } catch (e) {
      // Some providers/models reject response_format; retry without it.
      if (e instanceof OpenAI.APIError && e.status === 400) text = await complete(messages, false);
      else throw e;
    }
    try {
      const parsed = schema.safeParse(extractJson(text));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (e) {
      lastError = (e as Error).message;
    }
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: `Your JSON was invalid: ${lastError}. Reply again with the corrected full JSON object only.` });
  }
  throw new Error(`The AI returned invalid JSON twice: ${lastError}`);
}

let fallbackCache: { key: string; models: string[] } | undefined;

/** Alternatives to a failing model (cached list of this key's models). */
async function fallbackModels(failed: string): Promise<string[]> {
  const s = loadSettings();
  const cacheKey = `${s.baseUrl}|${s.apiKey.slice(-6)}`;
  try {
    if (fallbackCache?.key !== cacheKey) fallbackCache = { key: cacheKey, models: await listModels() };
  } catch {
    return [];
  }
  return testCandidates(fallbackCache.models, failed).slice(0, 3);
}

/** Models the provider offers for this key (OpenAI-compatible GET /models). */
export async function listModels(override?: Partial<StoredSettings>): Promise<string[]> {
  const { api } = client(override, QUICK);
  const ids: string[] = [];
  for await (const m of api.models.list()) ids.push(m.id.replace(/^models\//, ''));
  return [...new Set(ids)].sort();
}

/**
 * Best general-purpose chat model from a provider's list: prefers fast "flash"/"versatile"
 * models and skips embeddings, image, audio, preview and experimental variants.
 */
export function pickChatModel(ids: string[], preferred?: string): string | undefined {
  return rankChatModels(ids, preferred)[0];
}

/** Chat models in order of preference (see pickChatModel). */
export function rankChatModels(ids: string[], preferred?: string): string[] {
  // Not general chat models (media, audio, agents, research, embeddings, …).
  const NOT_CHAT =
    /embed|image|imagen|vision-only|tts|audio|speech|whisper|guard|moderation|aqa|veo|learnlm|live|native|computer-use|robotics|transcribe|translate|lyria|nano-banana|antigravity|deep-research|customtools|omni|argon/i;
  const usable = ids.filter((id) => !NOT_CHAT.test(id));
  const stable = usable.filter((id) => !/preview|exp|experimental|\d{4}-\d{2}-\d{2}|-\d{2}-\d{4}$|-\d{3}$/i.test(id));
  const pool = stable.length ? stable : usable;
  // Quality first: the always-current alias, then newest full "flash" models, then lite / small ones.
  const score = (id: string) => {
    const version = Number(id.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
    return (
      (/^gemini-flash-latest$/i.test(id) ? 3000 : 0) +
      (/flash|versatile|instruct|chat/i.test(id) ? 1000 : 0) -
      (isLite(id) ? 400 : 0) -
      (/gemma/i.test(id) ? 500 : 0) -
      (/pro/i.test(id) ? 300 : 0) +
      version
    );
  };
  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  return preferred && usable.includes(preferred) ? [preferred, ...ranked.filter((m) => m !== preferred)] : ranked;
}

/** Small / fast variants: quick to answer and usually more free quota. */
function isLite(id: string) {
  // Whole name parts only: "gemini" contains "mini" but is not a mini model.
  return /(^|[-_.])(lite|instant|8b|mini|small|nano)([-_.]|$)/i.test(id);
}

/** Models to try at once when the chosen one fails: the best full models plus the best quick ones as a safety net. */
export function testCandidates(ids: string[], exclude?: string): string[] {
  const ranked = rankChatModels(ids).filter((m) => m !== exclude);
  return [...ranked.filter((m) => !isLite(m)).slice(0, 2), ...ranked.filter(isLite).slice(0, 2)];
}

/** Settings-page checks must answer fast: one attempt, short timeout, no silent retries. */
const QUICK: Limits = { timeout: 40_000, maxRetries: 0, lowEffort: true };

export async function testConnection(override?: Partial<StoredSettings>): Promise<string> {
  const started = Date.now();
  const model = override?.model || loadSettings().model;
  try {
    const text = await complete([{ role: 'user', content: 'Reply with the single word: OK' }], false, override, QUICK);
    console.log(`[ai-test] ${model}: OK in ${Date.now() - started} ms`);
    return text.trim().slice(0, 100) || 'OK';
  } catch (e) {
    const err = e as Error & { status?: number };
    console.log(`[ai-test] ${model}: failed after ${Date.now() - started} ms — ${err.status ?? ''} ${err.message.slice(0, 300)}`);
    throw e;
  }
}
