import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(here, '..', '..');
export const APP_ROOT = path.resolve(SERVER_ROOT, '..');
export const WORKSPACE = process.env.WORKSPACE_DIR || path.join(APP_ROOT, 'workspace');
export const PROMPTS_DIR = path.join(SERVER_ROOT, 'src', 'prompts');
export const REFERENCE_DIR = path.join(SERVER_ROOT, 'reference');
export const CLIENT_DIST = path.join(APP_ROOT, 'client', 'dist');
