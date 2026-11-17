import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const MARKER_START = '/* AGY_I18N_PATCH_START */';
export const MARKER_END = '/* AGY_I18N_PATCH_END */';

/**
 * Resolves the target app.asar path from --asar flag or OS default install locations.
 */
export function resolveAsarPath() {
  const idx = process.argv.indexOf('--asar');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    return join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar');
  }
  if (process.platform === 'darwin') {
    return '/Applications/Antigravity.app/Contents/Resources/app.asar';
  }
  const candidates = [
    '/opt/Antigravity/resources/app.asar',
    '/usr/lib/antigravity/resources/app.asar',
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

/**
 * Checks whether the Antigravity desktop process is currently running.
 */
export function isAntigravityRunning() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
        encoding: 'utf8',
      });
      return /Antigravity\.exe/i.test(out);
    } catch {
      return false;
    }
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      execFileSync('pgrep', ['-x', 'Antigravity'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
