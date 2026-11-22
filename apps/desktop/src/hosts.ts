import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '../../../packages/protocol/src/client.ts';
import type { ServerEvent, SessionInfo } from '../../../packages/protocol/src/index.ts';
import type { BridgeHeader } from '../../../packages/cli/src/bridge.ts';
import { LOCAL_HOST, remoteId, splitId } from './bridge.ts';
import { spawn } from 'node:child_process';
import { RemoteFailure, classifyExit, connectRemote, sshArgs, sshFiles, untilReady, validHost, type ConnectOptions, type HostConfig, type RemoteConnection } from './remote.ts';
import { publicKeyLine, revokeScript } from './first-connect.ts';

// Remote hosts in the main process (docs/app-remote-spec.md): their configuration, one connection
// each, and the session ID prefix that keeps them apart from this machine's sessions.

export { LOCAL_HOST, splitId };
export const remoteSession = (host: string, info: SessionInfo): SessionInfo & { host: string } =>
  ({ ...info, sessionId: remoteId(host, info.sessionId), host });
export function remoteEvent(host: string, event: ServerEvent): ServerEvent {
  if (event.type === 'info') return { ...event, session: remoteSession(host, event.session) };
  return { ...event, sessionId: remoteId(host, event.sessionId) };
}

export class HostStore {
  private readonly file: string;
  constructor(file: string) { this.file = file; }
  async load(): Promise<HostConfig[]> {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`远程主机配置读取失败：${(error as Error).message}`);
    }
    const hosts = (saved as { hosts?: unknown }).hosts;
    if (!Array.isArray(hosts)) throw new Error('远程主机配置格式无效');
    return hosts.filter((host): host is HostConfig => validHost(host) && typeof (host as HostConfig).id === 'string'
      && /^h[0-9a-f]{8}$/.test((host as HostConfig).id));
  }
  async save(hosts: HostConfig[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.tmp';
    await writeFile(temporary, JSON.stringify({ v: 1, hosts }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

export const newHostId = (): string => 'h' + randomBytes(4).toString('hex');

export type HostState = 'connecting' | 'connected' | 'waiting' | 'version' | 'stopped';
export interface HostView extends HostConfig {
  state: HostState;
  error?: string;
  // Epoch ms of the next automatic attempt while waiting.
  retryAt?: number;
  remoteVersion?: string;
  shell?: BridgeHeader['shell'];
  home?: string;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// Events: 'event' (prefixed ServerEvent), 'change' (state or error changed).
export class RemoteHost extends EventEmitter {
  config: HostConfig;
  private readonly options: ConnectOptions;
  private client: Client | null = null;
  private header: BridgeHeader | undefined;
  private state: HostState = 'stopped';
  private error: string | undefined;
  private remoteVersion: string | undefined;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private retryAt: number | undefined;
  private generation = 0;

  constructor(config: HostConfig, options: ConnectOptions) {
    super();
    this.config = config;
    this.options = options;
  }

  get connection(): Client | null { return this.client; }
  get connected(): boolean { return this.client !== null; }

  view(): HostView {
    return { ...this.config, state: this.state, ...(this.error ? { error: this.error } : {}),
      ...(this.retryAt ? { retryAt: this.retryAt } : {}), ...(this.remoteVersion ? { remoteVersion: this.remoteVersion } : {}),
      ...(this.header ? { shell: this.header.shell, home: this.header.home } : {}) };
  }

  // Manual connect and reconnect both start from the shortest delay.
  start(): void {
    this.attempt = 0;
    this.clearTimer();
    if (this.client) { this.client.close(); return; }
    void this.connect();
  }

  stop(error?: string): void {
    this.generation++;
    this.clearTimer();
    const client = this.client;
    this.client = null;
    this.state = 'stopped';
    this.error = error;
    client?.close();
    this.emit('change');
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.retryAt = undefined;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.state = 'connecting';
    this.emit('change');
    let connection: RemoteConnection | undefined;
    try {
      connection = await connectRemote(this.config, this.options);
      await untilReady(connection.client);
      await connection.client.request({ type: 'desktop-register', ...(this.options.appId ? { appId: this.options.appId } : {}) }, 5000);
    } catch (error) {
      connection?.client.close();
      if (generation !== this.generation) return;
      if (error instanceof RemoteFailure && error.kind === 'version') {
        this.state = 'version';
        this.error = error.message;
        this.remoteVersion = error.remoteVersion;
        this.emit('change');
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.schedule();
      return;
    }
    if (generation !== this.generation) { connection.client.close(); return; }
    const client = connection.client;
    this.client = client;
    this.header = connection.header;
    this.state = 'connected';
    this.error = undefined;
    this.remoteVersion = undefined;
    this.attempt = 0;
    client.on('event', (event: ServerEvent) => this.emit('event', remoteEvent(this.config.id, event)));
    client.on('fault', (fault: Error) => { this.error = fault.message; });
    client.on('disconnect', () => {
      if (this.client !== client) return;
      this.client = null;
      this.error ??= '连接已断开';
      this.schedule();
    });
    this.emit('change');
  }

  private schedule(): void {
    const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.state = 'waiting';
    this.retryAt = Date.now() + delay;
    this.timer = setTimeout(() => { this.timer = undefined; this.retryAt = undefined; void this.connect(); }, delay);
    this.emit('change');
  }
}

export interface CheckStep { label: string; ok: boolean; detail?: string }
// firstConnect: the key login or host key failed, so the dialog offers the one-time password login.
export interface CheckResult { ok: boolean; steps: CheckStep[]; firstConnect?: boolean }

// The add-host dialog's checklist: one bridge connection, then closed again.
export async function checkHost(host: Omit<HostConfig, 'id'>, options: ConnectOptions): Promise<CheckResult> {
  const login: CheckStep = { label: 'SSH 登录', ok: true, detail: '使用本机 ssh 的密钥或 ssh-agent' };
  let connection: RemoteConnection | undefined;
  try {
    connection = await connectRemote(host, options);
    await untilReady(connection.client);
    const { header } = connection;
    return { ok: true, steps: [login, { label: `找到 Tarmac ${header.version}`, ok: true, detail: header.hostname },
      { label: '版本与本机一致', ok: true },
      { label: header.daemon === 'started' ? 'daemon 已启动' : 'daemon 运行中', ok: true,
        detail: header.daemon === 'started' ? '原先没有运行，已在这台主机上启动' : undefined }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof RemoteFailure ? error.kind : 'bridge';
    if (kind === 'unreachable') return { ok: false, steps: [{ label: 'SSH 连接', ok: false, detail: message }] };
    if (kind === 'hostkey') return { ok: false, firstConnect: true, steps: [{ label: '主机指纹', ok: false, detail: message }] };
    if (kind === 'auth') return { ok: false, firstConnect: true, steps: [{ label: 'SSH 登录', ok: false, detail: message }] };
    if (kind === 'missing') return { ok: false, steps: [login, { label: '找到 Tarmac', ok: false, detail: message }] };
    const remote = error instanceof RemoteFailure ? error.remoteVersion : undefined;
    if (kind === 'version') return { ok: false, steps: [login, { label: `找到 Tarmac ${remote ?? ''}`.trim(), ok: true },
      { label: '版本与本机一致', ok: false, detail: message }] };
    return { ok: false, steps: [login, { label: 'daemon 可用', ok: false, detail: message }] };
  } finally { connection?.client.close(); }
}

// Removes the line deploy added, over the everyday key login; other lines stay as they are.
export async function revokeKey(host: Omit<HostConfig, 'id'>, options: Pick<ConnectOptions, 'ssh' | 'files'>): Promise<void> {
  const files = options.files ?? sshFiles();
  const line = await publicKeyLine(files);
  if (!line) return;
  const child = spawn(options.ssh ?? 'ssh', sshArgs({ ...host, command: '/bin/sh -s' }, files), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdin.on('error', () => {});
  child.stdin.end(revokeScript(line));
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`删除对方 authorized_keys 中的 Tarmac 公钥失败：${code === 1 ? stderr.trim() || '退出码 1' : classifyExit(code, stderr).message}`);
}
