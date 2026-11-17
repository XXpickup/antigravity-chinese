import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { readAsar, writeAsar } from './asar-lib.mjs';
import {
  isAntigravityRunning,
  MARKER_END,
  MARKER_START,
  resolveAsarPath,
} from './cli-utils.mjs';

function main() {
  const asarPath = resolveAsarPath();
  if (!existsSync(asarPath)) {
    console.error(`未找到 app.asar: ${asarPath}`);
    process.exit(1);
  }

  if (!process.argv.includes('--allow-running') && isAntigravityRunning()) {
    console.error('检测到 Antigravity 正在运行！请先完全退出 Antigravity 后再还原。');
    process.exit(1);
  }

  const backupPath = `${asarPath}.bak`;
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, asarPath);
    console.log(`已从备份还原原版 app.asar: ${backupPath} -> ${asarPath}`);
    return;
  }

  const { header, files } = readAsar(asarPath);
  const preloadEntry = files.get('dist/preload.js');
  if (!preloadEntry) {
    console.error('未找到备份文件，且 app.asar 中缺少 dist/preload.js。');
    process.exit(1);
  }

  const text = preloadEntry.data.toString('utf8');
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    console.log('未检测到补丁标记，当前已是未修改状态。');
    return;
  }

  const clean = text.slice(0, start).trimEnd() + text.slice(end + MARKER_END.length) + '\n';
  preloadEntry.data = Buffer.from(clean, 'utf8');
  const tmpPath = `${asarPath}.tmp`;
  writeAsar(tmpPath, header, files);
  renameSync(tmpPath, asarPath);
  console.log('已移除注入补丁并还原 dist/preload.js。');
}

main();
