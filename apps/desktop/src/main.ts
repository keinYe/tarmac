import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, dialog, type MessageBoxOptions } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../../packages/protocol/src/client.ts';
import { DAEMON_NODE_FLAGS } from '../../../packages/daemon/src/runtime.ts';
import { LIMITS, validSize, type ServerEvent, type SessionInfo } from '../../../packages/protocol/src/index.ts';
import { readEndpoint } from '../../../packages/protocol/src/platform.ts';
import { defaultShell } from '../../../packages/protocol/src/shell.ts';
import type { DesktopEvent, DesktopMetadata, DesktopRequest, ShellRcResult } from './bridge.ts';
import { ProjectStore, workspaceView } from './projects.ts';
import type { WorkspaceView } from './projects.ts';
import { exitDesktop } from './exit.ts';
import { applyShellRc, planShellRc, type RcPlan } from '../../../packages/cli/src/shell-rc.ts';
import { packagedHookCommand } from '../../../packages/cli/src/hook-command.ts';
import { HookInstaller } from './hooks.ts';
import { HostStore, LOCAL_HOST, RemoteHost, checkHost, newHostId, remoteSession, revokeKey, splitId } from './hosts.ts';
import type { HostConfig } from './remote.ts';
import { sshFiles, validHost } from './remote.ts';
import { uploadImage } from './image-upload.ts';
import { deployKey, knownName, probeHost, trustHost, type HostKey } from './first-connect.ts';
import { startTestSshServer } from './ssh-test-server.ts';

app.setName('tarmac-app');
const smoke = process.env.TARMAC_SMOKE === '1';
const overrideDir = process.env.TARMAC_DATA_DIR;
if (overrideDir) app.setPath('userData', path.join(path.resolve(overrideDir), 'electron'));
// Remote X sessions often blocklist the software GPU; WebGL is needed for the
// terminal's own box-drawing glyphs. xterm falls back to DOM rendering on failure.
if (process.platform === 'linux') app.commandLine.appendSwitch('ignore-gpu-blocklist');
// xrdp has no hardware GPU: everything is rasterized in software, so the renderer
// avoids idle repaints. The llvmpipe thread cap is set by the desktop entry, because
// the GPU process does not see environment changes made here.
const remoteDisplay = process.platform === 'linux' && Boolean(process.env.XRDP_SESSION);
const hidden = smoke || process.env.TARMAC_HIDDEN === '1';
let window: BrowserWindow | null = null;
let client: Client | null = null;
let connecting: Promise<void> | null = null;
let retry: NodeJS.Timeout | undefined;
let daemonSpawned = false;
let quitting = false;
let allowQuit = false;
let quitPending: Promise<void> | null = null;
let showExitDialog = messageBox;
let finishQuit = () => app.quit();
let dataDir: string;
let connectionError: string | undefined;
let shellRcPlan: RcPlan | undefined;
const remotes = new Map<string, RemoteHost>();
const probedKeys = new Map<string, HostKey>();
// One per App launch, kept across reconnects, so daemons can tell this App's own connections apart.
const appId = randomUUID();
let hostStore: HostStore;

function publish(event: DesktopEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('m0:event', event);
}

async function connectDaemon(): Promise<void> {
  if (client || quitting) return;
  if (connecting) return connecting;
  connecting = (async () => {
    let candidate: Client | undefined;
    try {
      const endpoint = readEndpoint(dataDir);
      candidate = await Client.connect(endpoint.path, 2000, endpoint.token);
      const connection = candidate;
      // A listening socket is not sufficient: the daemon may still be loading
      // its journal and registry. Publish readiness only after a valid reply.
      await connection.request({ type: 'list' }, 2000);
      await connection.request({ type: 'desktop-register', appId }, 2000);
      if (quitting) { connection.close(); return; }
      client = connection;
      connectionError = undefined;
      connection.on('event', event => publish(event));
      connection.on('fault', error => { connectionError = String(error.message ?? error); });
      connection.on('disconnect', () => {
        if (client !== connection) return;
        client = null;
        publish({ type: 'connection', host: LOCAL_HOST, connected: false, error: connectionError ?? '会话连接已断开，正在重连' });
        scheduleReconnect();
      });
      publish({ type: 'connection', host: LOCAL_HOST, connected: true });
    } catch (error) {
      candidate?.close();
      connectionError = error instanceof Error ? error.message : String(error);
      // A connected daemon that rejected the handshake must be retried, never
      // replaced by another process racing for the same socket.
      if (!candidate && !daemonSpawned) {
        daemonSpawned = true;
        const child = spawn(process.execPath, [...DAEMON_NODE_FLAGS, path.join(__dirname, '..', 'daemon.cjs'), '--data-dir', dataDir], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          cwd: dataDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', spawnError => {
          connectionError = `会话服务启动失败：${spawnError.message}`;
          publish({ type: 'connection', host: LOCAL_HOST, connected: false, error: connectionError });
        });
        child.unref();
      }
      publish({ type: 'connection', host: LOCAL_HOST, connected: false, error: connectionError });
      scheduleReconnect();
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

function scheduleReconnect(): void {
  if (quitting || retry) return;
  retry = setTimeout(() => { retry = undefined; void connectDaemon(); }, 500);
}

function messageBox(options: MessageBoxOptions) {
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

async function requestAppQuit(): Promise<void> {
  if (allowQuit) return;
  if (quitPending) return quitPending;
  quitPending = (async () => {
    try {
      if (connecting) await connecting;
      const connection = client;
      if (!connection) throw new Error('daemon unavailable during exit');
      const closed = await exitDesktop(connection, async () => {
        const result = await showExitDialog({ type: 'warning', title: '退出 Tarmac',
          message: '退出将结束此 App 托管的全部会话',
          detail: '其中的 Shell 和 agent 将停止，正在执行的任务会中断。其他终端中独立打开的会话不受影响。'
            + ([...remotes.values()].some(remote => remote.connected) ? '\n远程主机上的会话不受影响，会继续运行，下次打开时自动重连。' : ''),
          buttons: ['取消', '结束会话并退出'], defaultId: 0, cancelId: 0, noLink: true });
        return result.response === 1;
      }, () => { quitting = true; if (retry) clearTimeout(retry); retry = undefined; });
      if (closed) { allowQuit = true; finishQuit(); }
    } catch {
      const result = await showExitDialog({ type: 'warning', title: '退出 Tarmac',
        message: '暂时无法确认后台会话已关闭',
        detail: '可以取消退出并等待连接恢复，或仅退出 App 并保留后台会话。',
        buttons: ['取消', '仅退出 App'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response === 1) { quitting = true; allowQuit = true; finishQuit(); }
    } finally {
      if (!allowQuit) { quitting = false; if (!client) scheduleReconnect(); }
    }
  })();
  try { await quitPending; }
  finally { quitPending = null; }
}

function beginQuit(): void {
  void requestAppQuit().catch(() => {
    publish({ type: 'connection', host: LOCAL_HOST, connected: client !== null, error: '退出确认未完成，请重试' });
  });
}

function checkRequest(value: unknown): DesktopRequest {
  if (!value || typeof value !== 'object') throw new Error('无效请求');
  const request = value as Record<string, unknown>;
  // list and create name their host; other requests carry it in the session ID prefix.
  if (request.host !== undefined && (typeof request.host !== 'string' || !remotes.has(request.host))) throw new Error('远程主机无效');
  const host = request.host === undefined ? {} : { host: request.host as string };
  if (request.type === 'list' || request.type === 'system') return { type: request.type, ...host };
  if (request.type === 'create') {
    const options = request.options as Record<string, unknown> | undefined;
    if (!options || typeof options.command !== 'string' || !options.command || options.command.length > 4096
      || !Array.isArray(options.args) || options.args.length > 128
      || !options.args.every(arg => typeof arg === 'string' && arg.length <= 16384)
      || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)
      || !validSize(options.cols, options.rows)
      || (options.provider !== undefined && options.provider !== 'claude' && options.provider !== 'codex')) {
      throw new Error('启动参数无效');
    }
    return { type: 'create', ...host, options: {
      command: options.command,
      args: options.args as string[],
      cwd: options.cwd,
      cols: options.cols as number,
      rows: options.rows as number,
      ...(options.provider ? { provider: options.provider as 'claude' | 'codex' } : {}),
    } };
  }
  if (typeof request.sessionId !== 'string' || typeof request.instanceId !== 'string') throw new Error('会话标识无效');
  const identity = { sessionId: request.sessionId, instanceId: request.instanceId };
  switch (request.type) {
    case 'attach':
      if (request.ifFree !== undefined && typeof request.ifFree !== 'boolean') throw new Error('会话请求无效');
      return { type: 'attach', ...identity, ...(request.ifFree ? { ifFree: true } : {}) };
    case 'detach': case 'close': return { type: request.type, ...identity };
    case 'ack': case 'read':
      if (!Number.isSafeInteger(request.seq) || (request.seq as number) < 0) throw new Error('序号无效');
      if (request.type === 'ack' && request.part !== undefined) {
        if (!Number.isSafeInteger(request.part) || (request.part as number) < 0) throw new Error('序号无效');
        return { type: 'ack', seq: request.seq as number, part: request.part as number, ...identity };
      }
      return { type: request.type, seq: request.seq as number, ...identity };
    case 'resize':
      if (!validSize(request.cols, request.rows)) throw new Error('终端尺寸无效');
      return { type: 'resize', cols: request.cols as number, rows: request.rows as number, ...identity };
    case 'input':
      if (typeof request.data !== 'string' || Buffer.byteLength(request.data) > LIMITS.frameBytes / 2
        || (request.binary !== undefined && typeof request.binary !== 'boolean')) throw new Error('终端输入无效');
      return { type: 'input', data: request.data, binary: request.binary as boolean | undefined, ...identity };
    default: throw new Error('不允许的操作');
  }
}

function metadata(): DesktopMetadata {
  const shell = defaultShell();
  return {
    cwd: process.env.TARMAC_CWD ?? process.cwd(),
    shell: shell.command,
    shellArgs: shell.args,
    dataDir,
    platform: process.platform,
    remoteDisplay,
    connected: client !== null,
    version: app.getVersion(),
    smoke,
  };
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    icon: path.join(__dirname, 'tarmac.png'),
    minWidth: 760,
    minHeight: 520,
    show: !hidden,
    backgroundColor: '#121417',
    title: 'Tarmac',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: '#121417', symbolColor: '#e4e7ea', height: 36 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!allowQuit) { event.preventDefault(); beginQuit(); }
  });
  window.on('closed', () => { window = null; });
  await window.loadFile(path.join(__dirname, 'index.html'));
}

async function rendererState(): Promise<{ text: string; ready: boolean; nativeGreen?: boolean; pid?: number; sessionId?: string; instanceId?: string; attachMs?: number; error?: string }> {
  if (!window) throw new Error('window closed');
  return window.webContents.executeJavaScript('window.tarmacSmoke?.state() ?? { text: "", ready: false }');
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`desktop smoke timeout: ${JSON.stringify(await rendererState())}`);
}

async function runSmoke(): Promise<void> {
  if (!overrideDir) throw new Error('desktop smoke requires TARMAC_DATA_DIR');
  const press = (keyCode: string, modifiers: Array<'control' | 'shift'> = []): void => {
    window!.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window!.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const historyVisible = (): Promise<boolean> => window!.webContents.executeJavaScript('Boolean(document.querySelector(".app.with-history"))');
  const listed = async (): Promise<SessionInfo[]> => client!.request<SessionInfo[]>({ type: 'list' });
  const findSession = async (sessionId: string): Promise<SessionInfo> => {
    const found = (await listed()).find(item => item.sessionId === sessionId);
    if (!found) throw new Error(`session ${sessionId} missing from list`);
    return found;
  };
  await waitFor(async () => Boolean(await window?.webContents.executeJavaScript('Boolean(window.tarmacSmoke)')));
  if (Menu.getApplicationMenu() !== null) throw new Error('application menu is still present');
  const titlebar = await window!.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('.titlebar');
    return bar && { color: getComputedStyle(bar).backgroundColor, height: bar.getBoundingClientRect().height,
      contentTop: document.querySelector('.app').getBoundingClientRect().top };
  })()`);
  if (titlebar?.color !== 'rgb(18, 20, 23)' || titlebar.height !== 36 || titlebar.contentTop !== 36) {
    throw new Error(`unexpected titlebar: ${JSON.stringify(titlebar)}`);
  }
  // The bundled faces, not whatever the system has installed, must back the terminal grid.
  const fonts = await window!.webContents.executeJavaScript(`(() => ({
    faces: [...document.fonts].map(face => face.family.replaceAll('"', '') + ':' + face.style + ':' + face.status).sort(),
    credit: document.querySelector('.titlebar > .brand')?.title ?? '' }))()`);
  const expectedFaces = ['MiSans:normal:loaded', 'Ubuntu Sans Mono:italic:loaded', 'Ubuntu Sans Mono:normal:loaded', 'Ubuntu:normal:loaded'];
  if (JSON.stringify(fonts.faces) !== JSON.stringify(expectedFaces) || !fonts.credit.includes('MiSans')) {
    throw new Error(`bundled fonts not in use: ${JSON.stringify(fonts)}`);
  }
  await waitFor(async () => Boolean(client));
  // Title bar figures: the clock is drawn, and the renderer's system request reaches this machine's daemon.
  const system = await window!.webContents.executeJavaScript(`(async () => ({
    clock: document.querySelector('.titlebar .system-stats .sys-clock')?.textContent ?? '',
    sample: await window.tarmac.request({ type: 'system' }) }))()`);
  if (!/^\d\d:\d\d$/.test(system.clock) || !(system.sample?.cores > 0) || !(system.sample.memTotal >= system.sample.memAvailable)
    || (process.platform !== 'win32' && !system.sample.net)) {
    throw new Error(`unexpected title bar system figures: ${JSON.stringify(system)}`);
  }
  window!.webContents.focus();
  press('N', ['control', 'shift']);
  await waitFor(async () => (await rendererState()).ready);
  const shell = (await listed()).find(item => item.alive);
  if (!shell?.alive) throw new Error('Ctrl+Shift+N did not create a Shell');
  await client!.request({ type: 'close', sessionId: shell.sessionId, instanceId: shell.instanceId });
  await waitFor(async () => Boolean(await window!.webContents.executeJavaScript('Boolean(document.querySelector(".empty"))')));
  await window!.webContents.executeJavaScript('window.tarmacSmoke.start()');
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).text.includes('M0-DESKTOP-READY'));
  const before = await rendererState();
  if (!before.nativeGreen) throw new Error('native ANSI foreground color did not reach xterm');
  window!.webContents.focus();
  window!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H' });
  window!.webContents.sendInputEvent({ type: 'char', keyCode: 'h' });
  window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'H' });
  window!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await waitFor(async () => (await rendererState()).text.includes('M0-INPUT:h'));
  await waitFor(async () => (await rendererState()).text.includes('M0-CONTROLS-READY'));
  press('H', ['control', 'shift']);
  await waitFor(historyVisible);
  const repeatConsumed = await window!.webContents.executeJavaScript('!window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH", key: "H", ctrlKey: true, shiftKey: true, repeat: true, cancelable: true }))');
  await delay(100);
  if (!repeatConsumed || !await historyVisible()) throw new Error('repeated shortcut toggled history');
  press('H', ['control', 'shift']);
  await waitFor(async () => !await historyVisible());
  const parallelBefore = await rendererState();
  press('N', ['control', 'shift']);
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId !== parallelBefore.sessionId);
  const parallel = await rendererState();
  assert.equal((await listed()).filter(item => item.alive).length, 2, 'Ctrl+Shift+N starts a parallel Shell without closing the first');
  await client!.request({ type: 'close', sessionId: parallel.sessionId!, instanceId: parallel.instanceId! });
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === parallelBefore.sessionId
    && (await rendererState()).pid === parallelBefore.pid);
  await window!.webContents.executeJavaScript('document.querySelector(".terminal-pane.visible .xterm textarea").focus()');
  press('N', ['control']);
  press('H', ['control']);
  await waitFor(async () => /0e\s+08/.test((await rendererState()).text));
  if (await historyVisible()) throw new Error('Ctrl+H was handled as an App shortcut');
  await window!.webContents.reload();
  await waitFor(async () => (await rendererState()).ready && /0e\s+08/.test((await rendererState()).text));
  const after = await rendererState();
  if (before.pid !== after.pid) throw new Error('PTY pid changed during renderer reconnect');
  const active = await findSession((await rendererState()).sessionId!);
  await client!.request({ type: 'close', sessionId: active.sessionId, instanceId: active.instanceId });
  await waitFor(async () => !(await findSession(active.sessionId)).alive);
  const transcript = path.join(overrideDir, 'rollout-smoke-00000000-0000-4000-8000-000000000000.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'smoke-agent' } }) + '\n'
    + JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 1000, output_tokens: 200, cached_input_tokens: 800, total_tokens: 1200,
    } }, rate_limits: { limit_id: 'codex', primary: { window_minutes: 300, used_percent: 37, resets_at: Math.floor(Date.now() / 1000) + 15480 },
      secondary: { window_minutes: 10080, used_percent: 7, resets_at: Math.floor(Date.now() / 1000) + 554400 } } } }) + '\n');
  // A local fixture keeps this exact transcript open; no real agent or model call.
  const usageSession = await client!.request<SessionInfo>({ type: 'create', options: {
    command: 'node', args: ['--input-type=module', '-e',
      'import { openSync } from "node:fs"; process.title="codex"; openSync(process.argv[1], "r"); setInterval(() => {}, 1000);', transcript],
    cwd: path.resolve(__dirname, '../..'), cols: 80, rows: 24,
  } });
  await waitFor(async () => Boolean(await window!.webContents.executeJavaScript('document.querySelector(".token-usage")?.textContent === "Token 1.2K"')));
  const tooltip = await window!.webContents.executeJavaScript('document.querySelector(".token-usage").title');
  if (!tooltip.includes('1,200 tokens') || !tooltip.includes('输入（含缓存）：1,000')) throw new Error('token tooltip is incorrect');
  const quota = await window!.webContents.executeJavaScript('document.querySelector(".quota-usage")?.textContent');
  if (!quota?.includes('5h 已用 37%') || !quota.includes('7d 已用 7%') || !/\dh\d+m/.test(quota)) throw new Error('quota or reset countdown is missing');
  const colors = await window!.webContents.executeJavaScript(`(() => {
    const color = selector => getComputedStyle(document.querySelector(selector)).color;
    return { token: color('.token-usage'), period: color('.quota-period'), percent: color('.quota-percent'), reset: color('.quota-reset') };
  })()`);
  if (colors.token !== 'rgb(250, 179, 135)' || colors.period !== 'rgb(245, 194, 231)'
    || colors.percent !== 'rgb(166, 227, 161)' || colors.reset !== 'rgb(137, 180, 250)') throw new Error('usage palette differs from terminal statusline');
  await waitFor(async () => Boolean(await window!.webContents.executeJavaScript('Boolean(document.querySelector(".logo svg.brand-icon path") && document.querySelector(".branch svg.branch-icon circle"))')));
  await client!.request({ type: 'close', sessionId: usageSession.sessionId, instanceId: usageSession.instanceId });
  await waitFor(async () => Boolean(await window!.webContents.executeJavaScript('!document.querySelector(".token-usage")')));
  const claudeId = '00000000-0000-4000-8000-000000000001';
  const claudeConfig = path.join(overrideDir, 'claude');
  const claudeFile = path.join(claudeConfig, 'projects/smoke', `${claudeId}.jsonl`);
  const statusConfig = path.join(overrideDir, 'config');
  const statusFile = path.join(statusConfig, 'token-tracker/tt-status.json');
  const agentsFile = path.join(overrideDir, 'agents.json');
  const bin = path.join(overrideDir, 'bin');
  await Promise.all([mkdir(path.dirname(claudeFile), { recursive: true }), mkdir(path.dirname(statusFile), { recursive: true }), mkdir(bin, { recursive: true })]);
  await writeFile(claudeFile, JSON.stringify({ type: 'assistant', sessionId: claudeId, message: {
    id: 'smoke-response', usage: { input_tokens: 22040, cache_read_input_tokens: 25000, output_tokens: 157 },
  } }) + '\n');
  await writeFile(statusFile, JSON.stringify({ session_id: claudeId, transcript_path: claudeFile, _received_at: new Date().toISOString(),
    rate_limits: { five_hour: { used_percentage: 0, resets_at: Math.floor(Date.now() / 1000) + 17880 },
      seven_day: { used_percentage: 15, resets_at: Math.floor(Date.now() / 1000) + 478800 } },
  }));
  await writeFile(agentsFile, '[]');
  await writeFile(path.join(bin, 'claude'), '#!/usr/bin/env node\nimport {readFileSync} from "node:fs"; process.stdout.write(readFileSync('
    + JSON.stringify(agentsFile) + ', "utf8"));', { mode: 0o700 });
  const claudeSession = await client!.request<SessionInfo>({ type: 'create', options: {
    command: 'node', args: ['-e', 'process.title="claude"; setInterval(() => {}, 1000);'],
    cwd: path.resolve(__dirname, '../..'), cols: 80, rows: 24,
    env: { CLAUDE_CONFIG_DIR: claudeConfig, XDG_CONFIG_HOME: statusConfig, PATH: bin + path.delimiter + process.env.PATH },
  } });
  await writeFile(agentsFile, JSON.stringify([{ pid: claudeSession.pid, cwd: claudeSession.cwd, sessionId: claudeId }]));
  await waitFor(async () => Boolean(await window!.webContents.executeJavaScript('document.querySelector(".token-usage")?.textContent === "Token 47.2K"')));
  const claudeQuota = await window!.webContents.executeJavaScript('document.querySelector(".quota-usage")?.textContent');
  if (!claudeQuota?.includes('5h 已用 0%') || !claudeQuota.includes('7d 已用 15%')) throw new Error('Claude quota is missing');
  await client!.request({ type: 'close', sessionId: claudeSession.sessionId, instanceId: claudeSession.instanceId });
  await waitFor(async () => !(await findSession(claudeSession.sessionId)).alive);
  // A shell that execs into tmux (process.title stands in for the tmux client) shows the takeover card.
  const takeover = await client!.request<SessionInfo>({ type: 'create', options: {
    command: '/bin/sh', args: ['-c', 'exec node -e \'process.title="tmux: client"; setInterval(() => {}, 1000);\''],
    cwd: path.resolve(__dirname, '../..'), cols: 80, rows: 24,
  } });
  await waitFor(async () => Boolean(await window!.webContents.executeJavaScript('document.querySelector(".rc-card")?.textContent.includes("自动进入了 tmux")')));
  await window!.webContents.executeJavaScript('[...document.querySelectorAll(".rc-card button")].find(button => button.textContent === "忽略").click()');
  await waitFor(async () => !(await window!.webContents.executeJavaScript('Boolean(document.querySelector(".rc-card"))')));
  await client!.request({ type: 'close', sessionId: takeover.sessionId, instanceId: takeover.instanceId });
  await waitFor(async () => !(await findSession(takeover.sessionId)).alive);
  const codexEntry = path.join(overrideDir, '@openai/codex/bin/codex.js');
  await mkdir(path.dirname(codexEntry), { recursive: true });
  await writeFile(codexEntry, 'setInterval(() => {}, 1000);');
  for (const example of [
    { brand: 'kimi', name: 'Kimi', args: ['-e', 'process.title="kimi-code"; setInterval(() => {}, 1000);'] },
    { brand: 'agy', name: 'Antigravity', args: ['-e', 'process.title="agy"; setInterval(() => {}, 1000);'] },
    { brand: 'codex', name: 'Codex · deepseek', args: [codexEntry, '-p', 'deepseek'] },
    { brand: 'codex', name: 'Codex · ark', args: [codexEntry, '--profile=ark'] },
  ]) {
    const session = await client!.request<SessionInfo>({ type: 'create', options: {
      command: 'node', args: example.args, cwd: path.resolve(__dirname, '../..'), cols: 80, rows: 24,
      env: { KIMI_CODE_HOME: path.join(overrideDir, 'kimi') },
    } });
    await waitFor(async () => (await rendererState()).ready && Boolean(await window!.webContents.executeJavaScript(
      'document.querySelector(".identity .brand")?.textContent === ' + JSON.stringify(example.name))));
    const visible = await window!.webContents.executeJavaScript('Boolean(document.querySelector(' + JSON.stringify(`.logo.brand-${example.brand} svg path`) + '))');
    if (!visible) throw new Error(`missing ${example.brand} SVG`);
    if (await window!.webContents.executeJavaScript('Boolean(document.querySelector(".token-usage"))')) throw new Error('unassociated agent inherited usage');
    if (example.brand === 'kimi') {
      const id = 'kimi-desktop-smoke';
      const file = path.join(overrideDir, 'kimi/sessions/project', id, 'agents/main/wire.jsonl');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'usage.record', usage: { inputOther: 1000, output: 100, inputCacheRead: 100 } }) + '\n');
      for (const [name, at, payload] of [['UserPromptSubmit', 1000, { prompt: 'Kimi GUI fixture' }], ['Stop', 2000, {}]] as const) {
        await client!.request({ type: 'hook', event: { eventId: `kimi-smoke-${name}`, sessionId: session.sessionId,
          instanceId: session.instanceId, provider: 'kimi', agentPid: session.pid, hookStartedAt: at,
          payload: { hook_event_name: name, session_id: id, ...payload } } });
      }
      await waitFor(async () => Boolean(await window!.webContents.executeJavaScript(
        'document.querySelector(".token-usage")?.textContent === "Token 1.2K" && document.querySelector(".session .state.waiting")?.textContent === "等待输入"')));
    }
    await client!.request({ type: 'close', sessionId: session.sessionId, instanceId: session.instanceId });
    await waitFor(async () => !(await findSession(session.sessionId)).alive);
  }
  const root = path.resolve(__dirname, '../..');
  const alternate = path.join(overrideDir, 'other-project');
  await mkdir(alternate, { recursive: true });
  const parallelSessions: SessionInfo[] = [];
  const stress = process.env.TARMAC_STRESS === '1';
  const sessionCount = stress ? 8 : 3;
  for (let index = 0; index < sessionCount; index++) {
    parallelSessions.push(await client!.request<SessionInfo>({ type: 'create', options: {
      command: 'node', args: [path.join(root, 'packages/daemon/test/fake-agent.mjs')], cwd: index === 2 ? alternate : root,
      cols: 80, rows: 24, env: { CLAUDE_CONFIG_DIR: path.join(overrideDir, 'empty-claude'),
        TARMAC_TEST_PROVIDER: ['claude', 'codex', 'kimi-code', 'agy'][index % 4] },
    } }));
  }
  await waitFor(async () => await window!.webContents.executeJavaScript(`document.querySelectorAll('.session').length === ${sessionCount} && document.querySelectorAll('.group').length === 2`));
  await waitFor(async () => {
    const current = await listed();
    return parallelSessions.every((info, index) => current.find(item => item.sessionId === info.sessionId)?.foreground?.provider === ['claude', 'codex', 'kimi', 'agy'][index % 4]);
  });
  const selectSession = async (info: SessionInfo): Promise<void> => {
    await window!.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-session-id="${info.sessionId}"]`)}).click()`);
    await waitFor(async () => { const current = await rendererState(); return current.ready && current.sessionId === info.sessionId; });
  };
  for (const [index, info] of parallelSessions.entries()) {
    await selectSession(info);
    await client!.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: `marker-${index}\n` });
    await waitFor(async () => (await rendererState()).text.includes(`INPUT:marker-${index}`));
    for (const other of [0, 1, 2].filter(value => value !== index)) assert.ok(!(await rendererState()).text.includes(`INPUT:marker-${other}`));
  }
  // Quick selection changes must leave only the final target accepting input.
  await window!.webContents.executeJavaScript(`(() => {
    const ids = ${JSON.stringify(parallelSessions.map(info => info.sessionId))};
    for (let i = 0; i < 20; i++) document.querySelector('[data-session-id="' + ids[i % ids.length] + '"]').click();
  })()`);
  const chosen = parallelSessions[1];
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === parallelSessions[19 % sessionCount].sessionId);
  await selectSession(chosen);
  const durations: number[] = [];
  const clickDurations: number[] = [];
  const reconnects: number[] = [];
  let splitBaseReconnectMs: number | undefined;
  let floodBytes = 0;
  if (stress) {
    const expected = new Map<string, string>();
    const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
    for (const [index, info] of parallelSessions.entries()) {
      await selectSession(info);
      await client!.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: `flood 60000\nmarker-stress-${index}\n` });
      await waitFor(async () => (await rendererState()).text.includes(`INPUT:marker-stress-${index}`));
      expected.set(info.sessionId, digest((await rendererState()).text));
      floodBytes += Buffer.byteLength('fixture-output-中文\r\n') * 60000;
    }
    for (let index = 0; index < 200; index++) {
      const info = parallelSessions[index % sessionCount];
      const started = performance.now();
      await selectSession(info);
      const current = await rendererState();
      clickDurations.push(performance.now() - started);
      assert.ok(current.attachMs !== undefined && Number.isFinite(current.attachMs));
      durations.push(current.attachMs);
      assert.equal(current.pid, info.pid);
      assert.equal(digest(current.text), expected.get(info.sessionId), 'switch restores the retained terminal text exactly');
    }
    await selectSession(chosen);
    for (let index = 0; index < 30; index++) {
      const beforeReconnect = client!;
      const started = performance.now();
      beforeReconnect.close();
      await waitFor(async () => Boolean(client && client !== beforeReconnect) && (await rendererState()).ready && (await rendererState()).sessionId === chosen.sessionId);
      reconnects.push(performance.now() - started);
      assert.equal(digest((await rendererState()).text), expected.get(chosen.sessionId), 'reconnect restores retained terminal text exactly');
    }
    // A colorful scrollback compacts into a base far larger than one frame. Restoring it once
    // closed the connection on every attach; it must now arrive in parts after a reconnect.
    const colorful = await client!.request<SessionInfo>({ type: 'create', options: {
      command: 'node', args: [path.join(root, 'packages/daemon/test/colorful.mjs'), '200', '6000'], cwd: root, cols: 200, rows: 40 } });
    await waitFor(async () => await window!.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${colorful.sessionId}"]`)}))`));
    await selectSession(colorful);
    for (let attempt = 0; !(await rendererState()).text.includes('COLORFUL-DONE'); attempt++) {
      if (attempt === 5) throw new Error('colorful fixture did not finish');
      await waitFor(async () => (await rendererState()).text.includes('COLORFUL-DONE')).catch(() => {});
    }
    const beforeSplit = client!;
    const splitStarted = performance.now();
    beforeSplit.close();
    await waitFor(async () => Boolean(client && client !== beforeSplit) && (await rendererState()).ready && (await rendererState()).sessionId === colorful.sessionId);
    splitBaseReconnectMs = performance.now() - splitStarted;
    assert.ok((await rendererState()).text.includes('COLORFUL-DONE'), 'a split base restores the terminal');
    await client!.request({ type: 'close', sessionId: colorful.sessionId, instanceId: colorful.instanceId });
    await selectSession(chosen);
    durations.sort((a, b) => a - b);
    clickDurations.sort((a, b) => a - b);
    const switchP95Ms = durations[Math.ceil(durations.length * 0.95) - 1];
    const reconnectMaxMs = Math.max(...reconnects);
    await writeFile(path.join(overrideDir, 'm1-stress.json'), JSON.stringify({
      status: floodBytes >= 10 * 1024 * 1024 && switchP95Ms <= 500 && reconnectMaxMs <= 10_000 ? 'pass' : 'fail',
      sessions: sessionCount, providers: ['claude', 'codex', 'kimi', 'agy'], floodBytes,
      switches: durations.length, switchP95Ms, clickToReadyP95Ms: clickDurations[Math.ceil(clickDurations.length * 0.95) - 1],
      reconnects: reconnects.length, reconnectMaxMs, retainedTextMatches: true, splitBaseReconnectMs }, null, 2) + '\n');
    assert.ok(floodBytes >= 10 * 1024 * 1024);
    assert.ok(switchP95Ms <= 500, 'switch p95 exceeds frozen 500ms budget');
    assert.ok(reconnectMaxMs <= 10_000, 'reconnect exceeds frozen 10s budget');
  }
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === chosen.sessionId);
  const oldClient = client!;
  oldClient.close();
  await waitFor(async () => Boolean(client && client !== oldClient) && (await rendererState()).ready && (await rendererState()).sessionId === chosen.sessionId);
  assert.equal((await rendererState()).pid, chosen.pid, 'socket reconnect keeps the selected PTY');
  // Force a background-only transfer on the shared transport. Its resync must
  // not disable the displayed terminal.
  await client!.request({ type: 'attach', sessionId: parallelSessions[0].sessionId, instanceId: parallelSessions[0].instanceId });
  const endpoint = readEndpoint(dataDir);
  const other = await Client.connect(endpoint.path, 2000, endpoint.token);
  const otherEvents: ServerEvent[] = [];
  other.on('event', event => otherEvents.push(event));
  try {
    await other.request({ type: 'attach', sessionId: parallelSessions[0].sessionId, instanceId: parallelSessions[0].instanceId });
    await delay(100);
    assert.equal((await rendererState()).ready, true);
    assert.equal((await rendererState()).sessionId, chosen.sessionId);
    await client!.request({ type: 'input', sessionId: chosen.sessionId, instanceId: chosen.instanceId, data: 'after-background-transfer\n' });
    await waitFor(async () => (await rendererState()).text.includes('INPUT:after-background-transfer'));
    // Selecting the session the other connection uses shows a notice instead of taking it over.
    const busy = parallelSessions[0];
    await window!.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-session-id="${busy.sessionId}"]`)}).click()`);
    await waitFor(async () => (await rendererState()).sessionId === busy.sessionId
      && await window!.webContents.executeJavaScript('document.querySelector(".elsewhere")?.textContent.includes("另一个 Tarmac 窗口")'));
    await delay(200);
    if ((await rendererState()).ready || otherEvents.some(event => event.type === 'resync')) throw new Error('selecting took the session from the other connection');
    if (await window!.webContents.executeJavaScript('Boolean(document.querySelector(".side .error"))')) throw new Error('control elsewhere was reported as an error');
    await window!.webContents.executeJavaScript('[...document.querySelectorAll(".elsewhere button")].find(button => button.textContent === "在这里继续").click()');
    await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === busy.sessionId
      && otherEvents.some(event => event.type === 'resync') && !await window!.webContents.executeJavaScript('Boolean(document.querySelector(".elsewhere"))'));
    await selectSession(chosen);
  } finally { other.close(); }
  window!.webContents.reload();
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === chosen.sessionId);
  assert.equal((await rendererState()).pid, chosen.pid, 'renderer reload restores the chosen session');
  for (const info of parallelSessions) await client!.request({ type: 'close', sessionId: info.sessionId, instanceId: info.instanceId });
  await waitFor(async () => await window!.webContents.executeJavaScript('Boolean(document.querySelector(".empty"))'));
  await runRemoteSmoke();
  // Every session has ended, so clearing leaves the history empty; the first click only arms it.
  const recentRows = () => window!.webContents.executeJavaScript('document.querySelectorAll(".host[data-host=local] .recent").length');
  await waitFor(async () => await recentRows() > 0);
  const clearButton = 'document.querySelector(".host[data-host=local] .clear-recent")';
  await window!.webContents.executeJavaScript(`${clearButton}.click()`);
  if (await window!.webContents.executeJavaScript(`${clearButton}.textContent`) !== '确认清除' || await recentRows() === 0) throw new Error('one click cleared the history');
  await window!.webContents.executeJavaScript(`${clearButton}.click()`);
  await waitFor(async () => await recentRows() === 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(app.getPath('userData'), 'projects.json'), 'utf8')).recent, []);
  await runExitSmoke();
  console.log(JSON.stringify({ desktopSmoke: 'pass', pid: after.pid, stress, checks: ['renderer', 'no-menu', 'titlebar-layout', 'bundled-fonts', 'keyboard-input', 'ctrl-shift-new', 'ctrl-shift-history', 'shortcut-repeat', 'ctrl-n-h-passthrough', 'snapshot-reconnect', 'pty-pid-stable', 'session-token-header', 'quota-reset-header', 'brand-branch-svg', 'titlebar-system-stats', 'token-clear-on-exit', 'claude-without-fd-header', 'native-ansi-color', 'kimi-agy-identities', 'codex-profiles', 'tmux-takeover-card', 'multi-session-two-project-sidebar', 'isolated-terminal-switch', 'rapid-switch', 'socket-reconnect-same-instance', 'background-resync-isolation', 'busy-session-notice-takeover', 'selection-persistence', 'remote-first-connection-ui', 'remote-real-ssh-key-login', 'remote-empty-host-new-shell', 'local-host-new-shell', 'remote-host-sessions', 'remote-paste-image', 'remote-ctrl-v-text-passthrough', 'remote-drop-image', 'remote-new-shell', 'remote-disconnect-stale', 'remote-reconnect-restore', 'remote-remove-revokes-key-keeps-sessions', 'clear-recent-projects', 'window-close-cancel', 'quit-dialog-dedup', 'confirmed-exit-stops-daemon'] }));
}

// A second daemon stands in for another machine, behind a local SSH server that the real ssh client
// logs in to; the dialog goes through the first connection (host key, password, key deployment).
async function runRemoteSmoke(): Promise<void> {
  const js = <T>(code: string): Promise<T> => window!.webContents.executeJavaScript(code);
  const remoteDir = path.join(dataDir, 'remote');
  const remoteHome = path.join(dataDir, 'remote-home');
  await mkdir(remoteHome, { recursive: true });
  const server = await startTestSshServer({ user: os.userInfo().username, password: 'smoke-password', home: remoteHome });
  try {
    const command = `env ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${path.join(__dirname, '..', 'cli.cjs')}' bridge --data-dir '${remoteDir}'`;
    // React keeps input values in state; set them the way typing does.
    const fill = (id: string, value: string) => js(`(() => { const input = document.getElementById(${JSON.stringify(id)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const press = (label: string) => js<boolean>(`(() => { const button = [...document.querySelectorAll('.dialog button')].find(item => item.textContent === ${JSON.stringify(label)});
      if (!button || button.disabled) return false; button.click(); return true; })()`);
    await js(`document.querySelector('.add-host').click()`);
    await waitFor(() => js(`Boolean(document.getElementById('host-address'))`));
    await fill('host-address', '127.0.0.1');
    await fill('host-port', String(server.port));
    await fill('host-name', 'smoke-remote');
    await fill('host-command', command);
    assert.ok(await press('连接并检查'));
    // Unknown host key: the dialog shows the fingerprint the server really has.
    await waitFor(() => js(`document.querySelector('.trust .fingerprint')?.textContent === ${JSON.stringify(server.fingerprint)}`));
    assert.ok(await press('接受并保存'));
    await waitFor(() => js(`Boolean(document.getElementById('host-password'))`));
    await fill('host-password', 'smoke-password');
    assert.ok(await press('用密码登录并部署密钥'));
    await waitFor(() => js(`[...document.querySelectorAll('.dialog button')].some(item => item.textContent === '添加')
      && [...document.querySelectorAll('.checks li')].at(-1)?.textContent.includes('daemon 已启动')`));
    if (!(await readFile(path.join(remoteHome, '.ssh/authorized_keys'), 'utf8')).includes(' tarmac-app\n')) throw new Error('the key was not deployed');
    if (await js(`document.getElementById('host-password')?.value ?? ''`)) throw new Error('the password stayed in the dialog');
    assert.ok(await press('添加'));
    await waitFor(() => js(`document.querySelectorAll('.host').length === 2 && [...document.querySelectorAll('.host .conn')].some(item => item.textContent === '已连接')`));
    const id = await js<string>(`document.querySelector('.host[data-host^="h"]').dataset.host`);
    await runRemoteSessions(js, id, remoteDir);
    // Removing through the dialog also takes Tarmac's line out of the host's authorized_keys.
    await js(`document.querySelector('.host[data-host="${id}"] .more').click()`);
    await js(`[...document.querySelectorAll('.menu button')].find(item => item.textContent === '从列表移除').click()`);
    await waitFor(() => js(`document.getElementById('host-revoke')?.checked === true`));
    assert.ok(await press('移除'));
    await waitFor(() => js(`document.querySelectorAll('.host').length === 1 && !document.querySelector('[data-session-id^="${id}:"]')`));
    if ((await readFile(path.join(remoteHome, '.ssh/authorized_keys'), 'utf8')).includes('tarmac-app')) throw new Error('the key was not revoked');
  } finally { server.close(); }
  const direct = await Client.connect(readEndpoint(remoteDir).path, 2000);
  try {
    if ((await direct.request<SessionInfo[]>({ type: 'list' })).filter(item => item.alive).length !== 3) throw new Error('removing the host ended its sessions');
    await direct.request({ type: 'shutdown' });
  } finally { direct.close(); }
}

// The remote shell echoes each line as REMOTE-INPUT:<line>. A clipboard image and a dropped image
// arrive as a path under the remote daemon's uploads/; a text-only clipboard leaves Ctrl+V to the
// shell (its line discipline takes it as literal-next), so the next key arrives as typed.
async function runRemoteImageSmoke(js: <T>(code: string) => Promise<T>, session: SessionInfo, remoteDir: string): Promise<void> {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const uploads = path.join(remoteDir, 'uploads', session.sessionId.slice(session.sessionId.indexOf(':') + 1));
  const saved = async () => (await readdir(uploads).catch(() => [] as string[])).map(name => path.join(uploads, name));
  const key = (keyCode: string, modifiers: ('control')[] = [], char?: string) => {
    window!.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) window!.webContents.sendInputEvent({ type: 'char', keyCode: char });
    window!.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const echoed = async (file: string) => (await rendererState()).text.replace(/\n/g, '').includes(`REMOTE-INPUT:${file}`);
  // The checks use the real system clipboard; whatever the user had there is put back afterwards.
  const previous = await clipboard.read().catch(() => [] as ClipboardItem[]);
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    key('V', ['control']);
    await waitFor(async () => (await saved()).length === 1);
    const [pasted] = await saved();
    if (!(await readFile(pasted)).subarray(0, 8).equals(png.subarray(0, 8))) throw new Error('the pasted image is not a PNG');
    key('Return');
    await waitFor(() => echoed(pasted));
    // Keys typed right after Ctrl+V wait for it, so the literal-next still applies to q, not to Enter.
    await clipboard.writeText('plain text');
    key('V', ['control']);
    key('Q', [], 'q');
    key('Return');
    await waitFor(async () => (await rendererState()).text.includes('REMOTE-INPUT:q'));
    if ((await saved()).length !== 1) throw new Error('a text clipboard was uploaded as an image');
    await js(`(() => { const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
      document.querySelector('.terminal-pane.visible').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); })()`);
    await waitFor(async () => (await saved()).length === 2);
    const dropped = (await saved()).find(file => file !== pasted)!;
    if (!(await readFile(dropped)).equals(png)) throw new Error('the dropped image changed on the way');
    key('Return');
    await waitFor(() => echoed(dropped));
  } finally {
    try { if (previous.length) await clipboard.write(previous); else await clipboard.clear(); } catch {}
  }
  if ((await rendererState()).error) throw new Error(`image paste reported: ${(await rendererState()).error}`);
}

async function runRemoteSessions(js: <T>(code: string) => Promise<T>, id: string, remoteDir: string): Promise<void> {
  // A new host has no session or history yet; its own entry starts a Shell in the remote home.
  await js(`document.querySelector('.host[data-host="${id}"] .host-new').click()`);
  await waitFor(async () => (await rendererState()).ready && Boolean((await rendererState()).sessionId?.startsWith(id + ':')));
  const firstShell = (await rendererState()).sessionId!;
  if (await js(`Boolean(document.querySelector('.host[data-host="${id}"] .host-new'))`)) throw new Error('the empty-host entry stayed after a session started');
  // While a remote session is selected, the 本机 menu still starts a Shell here; an empty 本机
  // group shows no 暂无会话 entry of its own.
  const listLocal = (): Promise<SessionInfo[]> => client!.request<SessionInfo[]>({ type: 'list' });
  const startLocal = async (click: () => Promise<unknown>): Promise<void> => {
    await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === firstShell);
    const before = new Set((await listLocal()).map(item => item.sessionId));
    await click();
    // The new Shell is selected, has no host prefix and is listed by this machine's daemon.
    await waitFor(async () => {
      const state = await rendererState();
      return state.ready && Boolean(state.sessionId) && !state.sessionId!.includes(':') && !before.has(state.sessionId!)
        && (await listLocal()).some(item => item.alive && item.sessionId === state.sessionId);
    });
    // Close it again and return to the remote Shell; later checks expect no open local directory.
    const localId = (await rendererState()).sessionId;
    const shell = (await listLocal()).find(item => item.sessionId === localId)!;
    await client!.request({ type: 'close', sessionId: shell.sessionId, instanceId: shell.instanceId });
    await waitFor(async () => !(await listLocal()).some(item => item.alive && item.sessionId === shell.sessionId));
    await js(`document.querySelector('.host[data-host="${id}"] [data-session-id="${firstShell}"]').click()`);
  };
  const clearLocal = 'document.querySelector(".host[data-host=local] .clear-recent")';
  if (await js(`Boolean(${clearLocal})`)) { await js(`${clearLocal}.click()`); await js(`${clearLocal}.click()`); }
  await waitFor(() => js(`!document.querySelector('.host[data-host="local"] .recent')`));
  if (await js(`Boolean(document.querySelector('.host[data-host="local"] .host-new'))`)) throw new Error('an empty 本机 group shows 暂无会话');
  await startLocal(async () => {
    await js(`document.querySelector('.host[data-host="local"] .more').click()`);
    const items = await js<string[]>(`[...document.querySelectorAll('.menu button')].map(item => item.textContent)`);
    if (JSON.stringify(items) !== JSON.stringify(['新建 Shell'])) throw new Error(`unexpected local host menu: ${JSON.stringify(items)}`);
    await js(`[...document.querySelectorAll('.menu button')].find(item => item.textContent === '新建 Shell').click()`);
  });
  const remoteSession = await js<SessionInfo>(`window.tarmac.request({ type: 'create', host: ${JSON.stringify(id)}, options: { command: '/bin/sh',
    args: ['-c', 'printf "REMOTE-READY\\r\\n"; while read value; do printf "REMOTE-INPUT:%s\\r\\n" "$value"; done'], cwd: ${JSON.stringify(dataDir)}, cols: 80, rows: 24 } })`);
  assert.ok(remoteSession.sessionId.startsWith(id + ':'), 'remote session IDs carry the host prefix');
  const pick = (sessionId: string) => js<boolean>(`(() => { const row = document.querySelector(${JSON.stringify(`.host[data-host="${id}"] [data-session-id="${sessionId}"]`)});
    row?.click(); return Boolean(row); })()`);
  await waitFor(async () => await pick(remoteSession.sessionId) && (await rendererState()).ready && (await rendererState()).sessionId === remoteSession.sessionId);
  await waitFor(async () => (await rendererState()).text.includes('REMOTE-READY'));
  if (!await js('document.querySelector(".titlebar .host-chip")?.textContent === "smoke-remote"')) throw new Error('titlebar does not name the remote host');
  window!.webContents.focus();
  await js('document.querySelector(".terminal-pane.visible .xterm textarea").focus()');
  for (const key of ['R', 'Return']) {
    window!.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key === 'R') window!.webContents.sendInputEvent({ type: 'char', keyCode: 'r' });
    window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
  }
  await waitFor(async () => (await rendererState()).text.includes('REMOTE-INPUT:r'));
  await runRemoteImageSmoke(js, remoteSession, remoteDir);
  // The title bar asks the remote host's daemon, over the bridge, for that machine's figures.
  if (!await js(`window.tarmac.request({ type: 'system', host: ${JSON.stringify(id)} }).then(sample => sample?.cores > 0 && sample.memTotal > 0
    && sample.utcOffset === -new Date(sample.at).getTimezoneOffset())`)) {
    throw new Error('remote host did not answer the system request');
  }
  // The selected remote session shows that host's clock, taken from its answer.
  await waitFor(() => js(`/^\\d\\d:\\d\\d$/.test(document.querySelector('.titlebar .sys-clock')?.textContent ?? '')
    && Boolean(document.querySelector('.titlebar .sys-mem'))`));
  // Ctrl+Shift+N follows the current session onto its host.
  window!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control', 'shift'] });
  window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control', 'shift'] });
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId !== remoteSession.sessionId);
  const shellId = (await rendererState()).sessionId!;
  assert.ok(shellId.startsWith(id + ':'), 'the new Shell runs on the remote host');
  await pick(remoteSession.sessionId);
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === remoteSession.sessionId);
  // A disconnected host keeps its sessions, marked unknown, and blocks input until it is back.
  await js(`window.tarmac.hosts({ type: 'disconnect', id: ${JSON.stringify(id)} })`);
  await waitFor(() => js(`Boolean(document.querySelector('.remote-offline')) && Boolean(document.querySelector('.host[data-host="${id}"] .state.stale'))
    && document.querySelector('.host[data-host="${id}"] .conn')?.textContent === '已断开'`));
  if ((await rendererState()).ready) throw new Error('input stayed enabled while the remote host was disconnected');
  // Disconnected: no figures, no clock (its time is unknown) and no error.
  if (await js(`window.tarmac.request({ type: 'system', host: ${JSON.stringify(id)} })`) !== null
    || await js('Boolean(document.querySelector(".titlebar .sys-mem, .titlebar .sys-clock"))')) throw new Error('a disconnected host still shows system figures');
  if (await js('Boolean(document.querySelector(".host[data-host=local] .state.stale"))')) throw new Error('local sessions were marked unknown');
  await js(`window.tarmac.hosts({ type: 'reconnect', id: ${JSON.stringify(id)} })`);
  await waitFor(async () => (await rendererState()).ready && (await rendererState()).sessionId === remoteSession.sessionId
    && (await rendererState()).text.includes('REMOTE-INPUT:r') && !await js('Boolean(document.querySelector(".remote-offline"))'));
  const direct = await Client.connect(readEndpoint(remoteDir).path, 2000);
  try {
    const alive = (await direct.request<SessionInfo[]>({ type: 'list' })).filter(item => item.alive).map(item => item.sessionId);
    assert.deepEqual(alive.sort(), [firstShell, remoteSession.sessionId, shellId].map(value => value.slice(id.length + 1)).sort());
  } finally { direct.close(); }
}

async function runExitSmoke(): Promise<void> {
  const connection = client!;
  const session = await connection.request<SessionInfo>({ type: 'create', options: {
    command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dataDir, cols: 80, rows: 24,
  } });
  const originalDialog = showExitDialog;
  const originalQuit = finishQuit;
  let announced = () => {};
  let answer = (_value: number) => {};
  const prompted = new Promise<void>(resolve => { announced = resolve; });
  const response = new Promise<number>(resolve => { answer = resolve; });
  let dialogs = 0;
  showExitDialog = async () => { dialogs++; announced(); return { response: await response, checkboxChecked: false }; };
  try {
    window!.close();
    await prompted;
    window!.close();
    app.quit();
    assert.equal(dialogs, 1, 'native close and before-quit share one confirmation');
    const cancel = quitPending;
    answer(0);
    await cancel;
    await waitFor(async () => quitPending === null);
    assert.ok(window && !window.isDestroyed());
    assert.equal((await connection.request<SessionInfo[]>({ type: 'list' })).find(item => item.sessionId === session.sessionId)?.alive, true);
    let committed = 0;
    showExitDialog = async () => ({ response: 1, checkboxChecked: false });
    // Preserve the test process long enough to report after the real shutdown.
    finishQuit = () => { committed++; };
    window.close();
    await quitPending;
    assert.equal(committed, 1);
    assert.equal(quitting, true);
    assert.equal(allowQuit, true);
    await connection.waitForDisconnect();
    assert.throws(() => process.kill(session.pid, 0), /ESRCH/);
  } finally { answer(0); showExitDialog = originalDialog; finishQuit = originalQuit; }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  dataDir = path.resolve(overrideDir ?? path.join(app.getPath('userData'), 'm0'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  ipcMain.handle('m0:ready', event => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    void connectDaemon();
    return metadata();
  });
  const projects = new ProjectStore(path.join(app.getPath('userData'), 'projects.json'));
  // Each remote host keeps its own project history; its directories are checked by its daemon.
  const remoteProjects = new Map<string, ProjectStore>();
  const projectsOf = (host: string): ProjectStore => {
    let store = remoteProjects.get(host);
    if (!store) { store = new ProjectStore(path.join(app.getPath('userData'), `projects-${host}.json`)); remoteProjects.set(host, store); }
    return store;
  };
  ipcMain.handle('m0:workspace', async (event, request: unknown): Promise<WorkspaceView | null> => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    const value = request as { type?: unknown; path?: unknown; current?: unknown; host?: unknown; keep?: unknown } | null;
    const directory = (dir: unknown): dir is string => typeof dir === 'string' && dir.length <= 4096 && !dir.includes('\0') && path.isAbsolute(dir);
    // clear keeps the directories the renderer still has open.
    const keep = (): string[] => {
      if (!Array.isArray(value?.keep) || value.keep.length > 256 || !value.keep.every(directory)) throw new Error('无效的项目请求');
      return value.keep as string[];
    };
    if (value?.host !== undefined) {
      if (typeof value.host !== 'string') throw new Error('远程主机无效');
      const remote = remotes.get(value.host);
      // A host removed moments ago can still be named by a renderer timer; there is nothing to show.
      if (!remote) return null;
      const store = projectsOf(remote.config.id);
      // Remote paths are POSIX; this machine's path module must not rewrite them.
      if (value.type === 'touch' && directory(value.path) && value.path.startsWith('/')) { await store.touch(path.posix.normalize(value.path)); return null; }
      if (value.type === 'clear') { await store.clear(keep().map(dir => path.posix.normalize(dir))); return null; }
      if (value.type !== 'view' || (value.current !== undefined && !directory(value.current))) throw new Error('无效的项目请求');
      const connection = remote.connection;
      // While disconnected the history stays listed; existence and branch are unknown.
      return workspaceView(store, value.current, connection
        ? paths => connection.request({ type: 'workspace', paths })
        : async paths => paths.map(dir => ({ path: dir, exists: true, branch: '' })));
    }
    if (value?.type === 'view' && (value.current === undefined || directory(value.current))) return workspaceView(projects, value.current);
    if (value?.type === 'touch' && directory(value.path)) { await projects.touch(path.resolve(value.path)); return null; }
    if (value?.type === 'clear') { await projects.clear(keep().map(dir => path.resolve(dir))); return null; }
    throw new Error('无效的项目请求');
  });
  hostStore = new HostStore(path.join(app.getPath('userData'), 'hosts.json'));
  // The desktop smoke keeps its Tarmac SSH files in its data directory, never the user's ~/.ssh (runRemoteSmoke).
  const hostFiles = sshFiles(smoke ? path.join(dataDir, 'ssh') : undefined);
  const hostOptions = { version: app.getVersion(), files: hostFiles, appId };
  const publishHosts = (): void => publish({ type: 'hosts', hosts: [...remotes.values()].map(remote => remote.view()) });
  const addRemote = (config: HostConfig): RemoteHost => {
    const remote = new RemoteHost(config, hostOptions);
    let connected = false;
    remote.on('event', event => publish(event));
    remote.on('change', () => {
      if (remote.connected !== connected) {
        connected = remote.connected;
        publish({ type: 'connection', host: config.id, connected, ...(remote.view().error ? { error: remote.view().error } : {}) });
      }
      publishHosts();
    });
    remotes.set(config.id, remote);
    return remote;
  };
  const saveHosts = () => hostStore.save([...remotes.values()].map(remote => remote.config));
  for (const config of await hostStore.load().catch(error => { console.error(error); return []; })) addRemote(config).start();
  ipcMain.handle('m0:hosts', async (event, request: unknown) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    const value = request as { type?: unknown; id?: unknown; host?: unknown; fingerprint?: unknown; password?: unknown; revoke?: unknown } | null;
    if (value?.type === 'list') return [...remotes.values()].map(remote => remote.view());
    const draft = (): Omit<HostConfig, 'id'> => {
      if (!validHost(value?.host)) throw new Error('主机信息无效：检查地址、用户名和端口');
      const { name, address, user, port, command } = value.host;
      return { name: name.trim(), address, ...(user ? { user } : {}), ...(port ? { port } : {}), ...(command?.trim() ? { command: command.trim() } : {}) };
    };
    if (value?.type === 'check') return checkHost(draft(), hostOptions);
    // First connection: the key the user confirms is the one this process saw, never one sent back.
    if (value?.type === 'probe') {
      const target = draft();
      const probe = await probeHost(target, hostFiles);
      probedKeys.set(knownName(target), probe.key);
      return { fingerprint: probe.key.fingerprint, keyType: probe.key.type, status: probe.status, previous: probe.previous };
    }
    if (value?.type === 'trust') {
      const target = draft();
      const key = probedKeys.get(knownName(target));
      if (!key || key.fingerprint !== value.fingerprint) throw new Error('主机指纹已过期，请重新检查');
      await trustHost(target, key, hostFiles);
      probedKeys.delete(knownName(target));
      return null;
    }
    if (value?.type === 'deploy') {
      const target = draft();
      if (typeof value.password !== 'string' || !value.password || value.password.length > 1024) throw new Error('请填写密码');
      await deployKey(target, value.password, hostFiles);
      const check = await checkHost(target, hostOptions);
      return { ...check, steps: [{ label: '用密码登录并部署密钥', ok: true, detail: '密码只用了这一次；公钥已加入对方的 ~/.ssh/authorized_keys' }, ...check.steps] };
    }
    if (value?.type === 'add') {
      const remote = addRemote({ id: newHostId(), ...draft() });
      await saveHosts();
      remote.start();
      return remote.view();
    }
    const remote = typeof value?.id === 'string' ? remotes.get(value.id) : undefined;
    if (!remote) throw new Error('远程主机无效');
    if (value?.type === 'update') {
      remote.config = { id: remote.config.id, ...draft() };
      await saveHosts();
      remote.start();
    } else if (value?.type === 'remove') {
      // Revoking needs the host and the key login; a failure keeps the host so nothing is half done.
      if (value.revoke === true) await revokeKey(remote.config, hostOptions);
      remotes.delete(remote.config.id);
      remote.stop();
      remote.removeAllListeners();
      await saveHosts();
      publish({ type: 'connection', host: remote.config.id, connected: false, removed: true });
    } else if (value?.type === 'reconnect') remote.start();
    else if (value?.type === 'disconnect') remote.stop('已手动断开');
    else throw new Error('无效的主机请求');
    publishHosts();
    return null;
  });
  ipcMain.handle('m0:request', async (event, request: unknown) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    const checked = checkRequest(request);
    if (quitting) throw new Error('App 正在退出');
    const remote = (host: string) => {
      const connection = remotes.get(host)?.connection;
      if (!connection) throw new Error(`${remotes.get(host)?.config.name ?? '远程主机'}未连接`);
      return connection;
    };
    // Polled by the title bar every few seconds; a failure only hides the figures.
    if (checked.type === 'system') {
      const connection = checked.host ? remotes.get(checked.host)?.connection : client;
      return connection ? connection.request({ type: 'system' }, 3000).catch(() => null) : null;
    }
    if (checked.type === 'list' || checked.type === 'create') {
      const { host, ...forward } = checked;
      if (host) {
        const value = await remote(host).request<SessionInfo | SessionInfo[]>(forward);
        return Array.isArray(value) ? value.map(info => remoteSession(host, info)) : remoteSession(host, value);
      }
      if (!client) throw new Error('会话服务尚未连接');
      return client.request(forward);
    }
    const { host, sessionId } = splitId(checked.sessionId);
    if (host !== LOCAL_HOST) return remote(host).request({ ...checked, sessionId });
    if (!client) throw new Error('会话服务尚未连接');
    return client.request(checked);
  });
  // An agent on another machine cannot read this machine's clipboard: the image is saved on the
  // session's machine and the renderer pastes the returned path. The clipboard is read here, so
  // the renderer only learns whether an image was there.
  ipcMain.handle('m0:upload-image', async (event, request: unknown): Promise<string | null> => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    const value = request as { sessionId?: unknown; instanceId?: unknown; data?: unknown } | null;
    if (typeof value?.sessionId !== 'string' || typeof value.instanceId !== 'string') throw new Error('会话标识无效');
    if (value.data !== undefined && !(value.data instanceof Uint8Array)) throw new Error('图片数据无效');
    let bytes: Uint8Array;
    if (value.data) bytes = value.data as Uint8Array;
    else {
      const item = (await clipboard.read()).find(entry => entry.types.some(type => type.startsWith('image/')));
      if (!item) return null;
      const type = item.types.includes('image/png') ? 'image/png' : item.types.find(entry => entry.startsWith('image/'))!;
      bytes = new Uint8Array(await (await item.getType(type) as Blob).arrayBuffer());
    }
    const { host, sessionId } = splitId(value.sessionId);
    const connection = host === LOCAL_HOST ? client : remotes.get(host)?.connection;
    if (!connection) throw new Error(host === LOCAL_HOST ? '会话服务尚未连接' : `${remotes.get(host)?.config.name ?? '远程主机'}未连接`);
    try {
      return await uploadImage(bytes, { sessionId, instanceId: value.instanceId }, part => connection.request(part, 15000));
    } catch (error) {
      if (error instanceof Error && error.message === 'unknown request type') throw new Error('对方的 Tarmac 版本过旧，不支持贴图，请升级后重启');
      throw error;
    }
  });
  // Editing shell startup files needs the user's click on a plan they have seen; the renderer
  // never supplies paths or content, only which step to run.
  ipcMain.handle('m0:shell-rc', async (event, request: unknown): Promise<ShellRcResult> => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    const type = (request as { type?: unknown } | null)?.type;
    const shell = process.env.SHELL ?? '/bin/sh';
    const backups = path.join(dataDir, 'shell-rc-backups');
    if (type === 'plan') {
      shellRcPlan = await planShellRc(shell, 'install');
      return { plan: shellRcPlan };
    }
    if (type === 'apply') {
      const plan = shellRcPlan;
      shellRcPlan = undefined;
      if (!plan) throw new Error('请先查看修复方案');
      return applyShellRc(plan, backups);
    }
    if (type === 'undo') return applyShellRc(await planShellRc(shell, 'uninstall'), backups);
    throw new Error('无效的启动文件请求');
  });
  // Only a packaged App has a stable location for hooks to point at.
  const hooks = new HookInstaller({ homeDir: os.homedir(), env: process.env, backupDir: path.join(dataDir, 'hook-config-backups'),
    ...(app.isPackaged ? { command: provider => packagedHookCommand({ platform: process.platform, execPath: process.execPath, resourcesPath: process.resourcesPath }, provider) } : {}),
    unavailable: '从仓库运行的 App 不提供 hooks 安装：hook 命令必须指向打包后的 App' });
  ipcMain.handle('m0:hooks', async (event, request: unknown) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    const value = request as { type?: unknown; provider?: unknown } | null;
    if (value?.type === 'apply') return hooks.apply();
    if (value?.type === 'undo') return hooks.undo();
    if (value?.provider !== 'claude' && value?.provider !== 'kimi' && value?.provider !== 'agy') throw new Error('无效的 hooks 请求');
    if (value.type === 'status') return hooks.status(value.provider);
    if (value.type === 'plan') return hooks.preview(value.provider);
    throw new Error('无效的 hooks 请求');
  });
  await createWindow();
  if (smoke) {
    try { await runSmoke(); }
    catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      if (client) await client.request({ type: 'shutdown' }).catch(() => {});
      app.exit(typeof process.exitCode === 'number' ? process.exitCode : Number(process.exitCode ?? 0));
    }
  }
}).catch(error => { console.error(error); app.exit(1); });

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', event => {
  if (!allowQuit) { event.preventDefault(); beginQuit(); return; }
  quitting = true;
  if (retry) clearTimeout(retry);
  client?.close();
  // Remote sessions keep running: the connection closes without desktop-exit.
  for (const remote of remotes.values()) remote.stop();
});
