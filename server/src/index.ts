import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { projects } from './routes/projects.js';
import { settings } from './routes/settings.js';
import { CLIENT_DIST, WORKSPACE, APP_ROOT } from './services/paths.js';
import { LlmNotConfiguredError } from './services/llm.js';
import { isHosted, withRequestSettings } from './services/settings.js';
import { removeIdleVisitors, withVisitor } from './services/store.js';

// .env lives at the repo root (npm workspaces run us from server/).
dotenv.config({ path: path.join(APP_ROOT, '.env') });

fs.mkdirSync(WORKSPACE, { recursive: true });

const app = express();
app.use(express.json({ limit: '20mb' }));

// Online demo: use the AI settings this visitor's browser sent with the request.
app.use((req, res, next) => {
  if (!isHosted()) return next();
  const header = (name: string) => req.header(name)?.trim() || undefined;
  // Download links cannot send headers, so the visitor id may also come in the query string.
  const visitor = header('x-visitor') ?? (typeof req.query.visitor === 'string' ? req.query.visitor : undefined);
  if (req.path.startsWith('/api/projects') && !/^[a-z0-9-]{8,64}$/i.test(visitor ?? '')) {
    return next(Object.assign(new Error('Missing visitor id — reload the page'), { status: 400 }));
  }
  res.locals.visitor = visitor;
  const baseUrl = header('x-ai-base-url');
  if (baseUrl && !baseUrl.toLowerCase().startsWith('https://')) return next(Object.assign(new Error('The online demo only calls https:// AI endpoints'), { status: 400 }));
  withRequestSettings(
    { provider: header('x-ai-provider') as never, baseUrl, model: header('x-ai-model'), apiKey: header('x-ai-key') },
    () => (visitor ? withVisitor(visitor, next) : next()),
  );
});

app.use('/api/projects', projects);
app.use('/api/settings', settings);
app.get('/api/health', (_req, res) => res.json({ ok: true }));

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof LlmNotConfiguredError ? 400 : (err.status ?? 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

// API_PORT first so dev tooling that sets PORT for Vite doesn't collide; hosts (Render etc.) set PORT.
const port = Number(process.env.API_PORT) || Number(process.env.PORT) || 3000;
// Locally, bind to localhost only: this app reads local files and holds an API key.
// The online demo must be reachable from outside, and has those features switched off.
const host = process.env.HOST || (isHosted() ? '0.0.0.0' : '127.0.0.1');
if (isHosted()) {
  const DAY = 24 * 60 * 60 * 1000;
  const sweep = () => {
    try {
      removeIdleVisitors(DAY);
    } catch (e) {
      console.error('[cleanup]', e);
    }
  };
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}
app.listen(port, host, () => {
  console.log(`PBI AutoBuilder running at http://localhost:${port}`);
});
