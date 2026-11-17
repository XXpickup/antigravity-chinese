import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAsar, writeAsar } from './asar-lib.mjs';
import {
  isAntigravityRunning,
  MARKER_END,
  MARKER_START,
  resolveAsarPath,
} from './cli-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripExistingPatch(source) {
  const start = source.indexOf(MARKER_START);
  const end = source.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return source.slice(0, start).trimEnd() + source.slice(end + MARKER_END.length);
  }
  return source;
}

function main() {
  const asarPath = resolveAsarPath();
  if (!existsSync(asarPath)) {
    console.error(`未找到 app.asar: ${asarPath}`);
    console.error('请通过 --asar <路径> 手动指定 app.asar 的位置。');
    process.exit(1);
  }

  if (!process.argv.includes('--allow-running') && isAntigravityRunning()) {
    console.error('检测到 Antigravity 正在运行！');
    console.error('请先完全退出 Antigravity（包括系统托盘/后台进程），然后再运行本脚本。');
    process.exit(1);
  }

  const dict = JSON.parse(readFileSync(join(__dirname, 'dictionary.json'), 'utf8'));
  const injectTpl = readFileSync(join(__dirname, 'i18n-inject.js'), 'utf8');
  const injectCode = injectTpl.replace('__AGY_I18N_DICT__', () => JSON.stringify(dict));

  const { header, files } = readAsar(asarPath);
  const preloadEntry = files.get('dist/preload.js');
  if (!preloadEntry) {
    console.error('app.asar 中未找到 dist/preload.js，结构与预期不符，已中止。');
    process.exit(1);
  }

  const preloadText = preloadEntry.data.toString('utf8');
  const alreadyPatched = preloadText.includes(MARKER_START);
  const backupPath = `${asarPath}.bak`;

  if (!alreadyPatched) {
    copyFileSync(asarPath, backupPath);
    console.log(`已备份原版 app.asar -> ${backupPath}`);
  } else {
    console.log('检测到 app.asar 已打过补丁，将基于当前版本更新注入内容...');
  }

  const cleanPreload = stripExistingPatch(preloadText);
  const patchedPreload = `${cleanPreload}\n\n${MARKER_START}\n${injectCode}\n${MARKER_END}\n`;
  preloadEntry.data = Buffer.from(patchedPreload, 'utf8');

  const tmpPath = `${asarPath}.tmp`;
  writeAsar(tmpPath, header, files);

  const verified = readAsar(tmpPath);
  if (!verified.files.get('dist/preload.js')?.data.toString('utf8').includes(MARKER_START)) {
    unlinkSync(tmpPath);
    throw new Error('校验打包后的 app.asar 失败，已回滚临时文件。');
  }

  renameSync(tmpPath, asarPath);
  console.log('补丁应用成功！');
  console.log('使用说明：启动 Antigravity 后默认显示中文，按 Alt+Shift+L 或点击右下角「中 / En」按钮可随时切换语言。');
}

main();
