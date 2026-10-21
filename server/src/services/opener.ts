import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// Opens files/folders on the user's machine without going through cmd.exe:
// `cmd /c start` mangles quotes and treats "&" in paths ("Collection & Recovery")
// as a command separator, so it silently failed for such projects.

let cachedPowerBi: string | null | undefined;

/** Path of Power BI Desktop (installer or Microsoft Store version), or null. */
export function findPowerBiDesktop(): string | null {
  if (cachedPowerBi !== undefined) return cachedPowerBi;
  if (process.platform !== 'win32') return (cachedPowerBi = null);
  const candidates = [
    process.env.PBI_DESKTOP_PATH,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft Power BI Desktop', 'bin', 'PBIDesktop.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Power BI Desktop', 'bin', 'PBIDesktop.exe'),
    // Microsoft Store version: execution alias.
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'PBIDesktopStore.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'PBIDesktop.exe'),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (fs.existsSync(p)) return (cachedPowerBi = p);
  }
  // Installer versions register an "App Path".
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PBIDesktop.exe`, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const m = out.match(/REG_SZ\s+(.+\.exe)/i);
      const exe = m?.[1].trim().replace(/^"|"$/g, '');
      if (exe && fs.existsSync(exe)) return (cachedPowerBi = exe);
    } catch {
      /* key not present */
    }
  }
  return (cachedPowerBi = null);
}

/** Start a process detached and resolve once it has started (reject if it could not). */
function launch(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function openFolder(folder: string) {
  if (process.platform === 'win32') await launch('explorer.exe', [folder]);
  else await launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [folder]);
}

/** Open a .pbip/.pbix in Power BI Desktop; falls back to the file's default app. */
export async function openInPowerBi(file: string): Promise<{ method: 'powerbi' | 'default-app'; exe?: string }> {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  cachedPowerBi = undefined; // re-detect: Power BI may have been installed since the last check
  const exe = findPowerBiDesktop();
  if (exe) {
    await launch(exe, [file]);
    return { method: 'powerbi', exe };
  }
  if (process.platform === 'win32') {
    // explorer.exe opens a file with its registered application.
    await launch('explorer.exe', [file]);
  } else {
    await launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [file]);
  }
  return { method: 'default-app' };
}
