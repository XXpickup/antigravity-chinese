import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MARKER_START = '/* AGY_I18N_PATCH_START */';
export const MARKER_END = '/* AGY_I18N_PATCH_END */';

/**
 * Reads CLI flag value (--flag value) or returns undefined.
 */
export function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

/**
 * Resolves the target app.asar path from --asar flag or OS default install locations.
 */
export function resolveAsarPath() {
  const explicit = getArgValue('--asar');
  if (explicit) return explicit;
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
 * Resolves the Antigravity executable path from --exe flag or OS defaults.
 */
export function resolveAntigravityExePath() {
  const explicit = getArgValue('--exe');
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    return join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe');
  }
  if (process.platform === 'darwin') {
    return '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
  }
  const candidates = [
    '/opt/Antigravity/antigravity',
    '/usr/bin/antigravity',
  ];
  return candidates.find((p) => existsSync(p)) || 'antigravity';
}

/**
 * Resolves the DevToolsActivePort file written by Electron when CDP is enabled.
 */
export function resolveDevToolsActivePortPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  return join(homedir(), '.config', 'Antigravity', 'DevToolsActivePort');
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

/**
 * Builds the standalone browser runtime script by embedding dictionary.json.
 */
export function buildInjectScript(baseDir) {
  const dict = JSON.parse(readFileSync(join(baseDir, 'dictionary.json'), 'utf8'));
  const injectTpl = readFileSync(join(baseDir, 'i18n-inject.js'), 'utf8');
  return injectTpl.replace('__AGY_I18N_DICT__', () => JSON.stringify(dict));
}
