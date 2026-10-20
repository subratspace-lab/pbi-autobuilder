import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { z } from 'zod';
import { PROMPTS_DIR } from './paths.js';
import { loadSettings } from './settings.js';

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('No AI provider configured. Add a free API key on the Settings page (or use the rule-based suggestions).');
  }
}

function client() {
  const s = loadSettings();
  if (!s.baseUrl || !s.model || (!s.apiKey && s.provider !== 'ollama')) throw new LlmNotConfiguredError();
  return {
    model: s.model,
    api: new OpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey || 'ollama', timeout: 180_000, maxRetries: 2 }),
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

async function complete(messages: OpenAI.Chat.ChatCompletionMessageParam[], jsonMode: boolean) {
  const { api, model } = client();
  const res = await api.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });
  return res.choices[0]?.message?.content ?? '';
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

export async function testConnection(): Promise<string> {
  const text = await complete([{ role: 'user', content: 'Reply with the single word: OK' }], false);
  return text.trim().slice(0, 100);
}
