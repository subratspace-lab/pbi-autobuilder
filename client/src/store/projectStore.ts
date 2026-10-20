import { create } from 'zustand';
import type { LlmSettings, Project } from '@shared/types';
import { api } from '../api/client';

export interface Toast {
  id: number;
  kind: 'error' | 'success' | 'info';
  text: string;
  details?: string[];
}

interface State {
  project: Project | null;
  settings: LlmSettings | null;
  busy: Record<string, boolean>;
  toasts: Toast[];
  loadProject(id: string): Promise<void>;
  setProject(p: Project): void;
  loadSettings(): Promise<void>;
  /** Run an async action with a busy flag and error toast. Returns undefined on failure. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
  toast(kind: Toast['kind'], text: string, details?: string[]): void;
  dismiss(id: number): void;
}

let nextToast = 1;

export const useStore = create<State>((set, get) => ({
  project: null,
  settings: null,
  busy: {},
  toasts: [],

  async loadProject(id) {
    if (get().project?.id === id) return;
    set({ project: null });
    await get().run('project', async () => set({ project: await api.project(id) }));
  },
  setProject: (project) => set({ project }),
  async loadSettings() {
    try {
      const { settings } = await api.settings();
      set({ settings });
    } catch {
      /* server not ready yet */
    }
  },

  async run(key, fn) {
    set((s) => ({ busy: { ...s.busy, [key]: true } }));
    try {
      return await fn();
    } catch (e) {
      get().toast('error', (e as Error).message);
      return undefined;
    } finally {
      set((s) => ({ busy: { ...s.busy, [key]: false } }));
    }
  },

  toast(kind, text, details) {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, details }] }));
    setTimeout(() => get().dismiss(id), kind === 'error' || details?.length ? 12000 : 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const aiReady = (s: LlmSettings | null) => Boolean(s?.hasApiKey);
