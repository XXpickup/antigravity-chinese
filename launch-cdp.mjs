import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './cdp-client.mjs';
import {
  buildInjectScript,
  getArgValue,
  isAntigravityRunning,
  resolveAntigravityExePath,
  resolveDevToolsActivePortPath,
} from './cli-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_UI_ORIGIN_RE = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)|antigravity:\/\/)/i;

function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function readDevToolsActivePort() {
  const file = resolveDevToolsActivePortPath();
  if (!existsSync(file)) return null;
  try {
    const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeCdpPort(explicitPort) {
  const candidates = [];
  if (explicitPort) candidates.push(explicitPort);
  const activePort = readDevToolsActivePort();
  if (activePort && activePort !== explicitPort) candidates.push(activePort);

  for (const port of candidates) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json/list`, 1000);
      if (Array.isArray(list)) {
        return { port, targets: list };
      }
    } catch {
      // Try next port candidate
    }
  }
  return null;
}

function isTargetInjectable(t) {
  if (!t || !t.webSocketDebuggerUrl) return false;
  if (t.type !== 'page' && t.type !== 'webview' && t.type !== 'iframe') return false;
  return LOCAL_UI_ORIGIN_RE.test(t.url || '');
}

function createDesktopShortcut() {
  if (process.platform !== 'win32') {
    console.error('--shortcut 目前仅支持 Windows 自动创建快捷方式。');
    process.exit(1);
  }
  const desktop = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', '[Environment]::GetFolderPath("Desktop")'],
    { encoding: 'utf8' }
  ).trim();
  const shortcutPath = join(desktop, 'Antigravity (中文版).lnk');
  const scriptPath = join(__dirname, 'launch-cdp.mjs');
  const iconPath = resolveAntigravityExePath();

  const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$sc.TargetPath = '${process.execPath.replace(/'/g, "''")}'
$sc.Arguments = '"${scriptPath.replace(/'/g, "''")}" --gui-prompt'
$sc.WorkingDirectory = '${__dirname.replace(/'/g, "''")}'
$sc.WindowStyle = 7
if (Test-Path '${iconPath.replace(/'/g, "''")}') { $sc.IconLocation = '${iconPath.replace(/'/g, "''")},0' }
$sc.Description = '以中文 CDP 动态注入模式启动 Antigravity'
$sc.Save()
`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  console.log(`已创建桌面快捷方式：${shortcutPath}`);
}

function stopAntigravityProcess() {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/F', '/IM', 'Antigravity.exe'], { stdio: 'ignore' });
  } else {
    execFileSync('pkill', ['-x', 'Antigravity'], { stdio: 'ignore' });
  }
}

function askGuiRestartWindows() {
  if (process.platform !== 'win32') return false;
  try {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$res = [System.Windows.Forms.MessageBox]::Show(
  "检测到 Antigravity 已在运行，但未开启 CDP 调试端口（常见于刚自动更新完或从原版图标启动）。\`n\`n是否立即重启 Antigravity 以开启中文界面？",
  "Antigravity 中文版 (CDP 模式)",
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Question
)
if ($res -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }
`;
    execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function attachTarget(target, injectCode, clients) {
  if (clients.has(target.id)) return;
  const placeholder = { closing: false };
  clients.set(target.id, placeholder);

  try {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    clients.set(target.id, client);
    client.onClose(() => {
      clients.delete(target.id);
    });

    await client.send('Page.enable').catch(() => undefined);
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: injectCode }).catch(() => undefined);
    await client.send('Runtime.evaluate', { expression: injectCode, returnByValue: false });
    console.log(`[CDP] 已注入汉化脚本 -> ${target.type}: ${target.title || target.url}`);
  } catch {
    clients.delete(target.id);
  }
}

async function main() {
  if (process.argv.includes('--shortcut')) {
    createDesktopShortcut();
    return;
  }

  const attachOnly = process.argv.includes('--attach-only');
  const forceRestart = process.argv.includes('--restart');
  const guiPrompt = process.argv.includes('--gui-prompt');
  const portArg = getArgValue('--port');
  const explicitPort = portArg ? Number(portArg) : 0;
  const injectCode = buildInjectScript(__dirname);

  let found = await probeCdpPort(explicitPort);
  let launchedByUs = false;

  if (!found) {
    if (attachOnly) {
      console.error('未检测到可连接的 Antigravity 调试端口。请先使用 node launch-cdp.mjs 启动后重试。');
      process.exit(1);
    }

    const exePath = resolveAntigravityExePath();
    if (process.platform === 'win32' && !existsSync(exePath)) {
      console.error(`未找到 Antigravity 可执行文件: ${exePath}`);
      console.error('请通过 --exe <路径> 指定程序位置。');
      process.exit(1);
    }

    if (isAntigravityRunning()) {
      // Brief grace wait in case Antigravity was just launched moments ago
      for (let i = 0; i < 4 && !found; i++) {
        await sleep(350);
        found = await probeCdpPort(explicitPort);
      }

      if (!found) {
        const shouldRestart = forceRestart || (guiPrompt && askGuiRestartWindows());
        if (!shouldRestart) {
          console.error('检测到当前运行的 Antigravity 未开启 CDP 调试端口（常见于刚自动更新完或从原版图标启动）。');
          console.error('请先完全退出 Antigravity（含后台托盘），或运行 node launch-cdp.mjs --restart 重启开启中文。');
          process.exit(1);
        }

        console.log('正在重启 Antigravity 以开启 CDP 调试端口...');
        try {
          stopAntigravityProcess();
        } catch {
          // Ignore if already exiting
        }
        const stopDeadline = Date.now() + 6000;
        while (Date.now() < stopDeadline && isAntigravityRunning()) {
          await sleep(250);
        }
      }
    }

    if (!found) {
      const args = [`--remote-debugging-port=${explicitPort || 0}`];
      console.log(`正在启动 Antigravity（免改安装包 CDP 模式）: ${exePath}`);
      const child = spawn(exePath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      launchedByUs = true;

      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        found = await probeCdpPort(explicitPort);
        if (found) break;
        await sleep(400);
      }

      if (!found) {
        console.error('等待 Antigravity CDP 调试端口超时。');
        console.error('请检查是否仍有未带调试端口的 Antigravity 后台进程残留。');
        process.exit(1);
      }
    }
  } else {
    console.log(`已连接运行中的 Antigravity CDP 端口: ${found.port}`);
  }

  const clients = new Map();
  let stopped = false;

  const cleanup = () => {
    stopped = true;
    for (const c of clients.values()) {
      if (typeof c.close === 'function') c.close();
    }
    clients.clear();
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Initial injection on discovered targets
  for (const t of found.targets) {
    if (isTargetInjectable(t)) {
      await attachTarget(t, injectCode, clients);
    }
  }

  console.log('CDP 汉化监视器运行中（按 Alt+Shift+L 可随时切换中/英；关闭 Antigravity 后会自动退出）...');

  let missCount = 0;
  while (!stopped) {
    await sleep(1500);
    try {
      const list = await httpGetJson(`http://127.0.0.1:${found.port}/json/list`, 1200);
      missCount = 0;
      for (const t of list) {
        if (isTargetInjectable(t) && !clients.has(t.id)) {
          await attachTarget(t, injectCode, clients);
        }
      }
    } catch {
      missCount++;
      if (missCount >= 3 && !isAntigravityRunning()) {
        console.log('检测到 Antigravity 已退出，CDP 监视器结束。');
        cleanup();
        break;
      }
      // If Antigravity restarted on a new dynamic port, re-probe
      if (missCount >= 3 && launchedByUs) {
        const reprobe = await probeCdpPort(explicitPort);
        if (reprobe) {
          found = reprobe;
          missCount = 0;
        }
      }
    }
  }
}

main().catch((err) => {
  console.error('CDP 模式运行出错:', err.message);
  process.exit(1);
});
