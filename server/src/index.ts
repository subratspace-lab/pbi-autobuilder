import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { projects } from './routes/projects.js';
import { settings } from './routes/settings.js';
import { CLIENT_DIST, WORKSPACE, APP_ROOT } from './services/paths.js';
import { LlmNotConfiguredError } from './services/llm.js';

// .env lives at the repo root (npm workspaces run us from server/).
dotenv.config({ path: path.join(APP_ROOT, '.env') });

fs.mkdirSync(WORKSPACE, { recursive: true });

const app = express();
app.use(express.json({ limit: '20mb' }));

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

// API_PORT (not PORT) so dev tooling that sets PORT for Vite doesn't collide.
const port = Number(process.env.API_PORT) || 3000;
// Bind to localhost only: this app reads local files and holds an API key.
app.listen(port, '127.0.0.1', () => {
  console.log(`PBI AutoBuilder running at http://localhost:${port}`);
});
