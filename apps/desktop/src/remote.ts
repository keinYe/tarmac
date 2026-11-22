import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { Client } from '../../../packages/protocol/src/client.ts';
import { VERSION } from '../../../packages/protocol/src/index.ts';
import type { BridgeHeader } from '../../../packages/cli/src/bridge.ts';

// The App's connection to another machine's daemon: system ssh runs `tarmac bridge` there, whose
// stdio carries the daemon protocol after one header line (docs/app-remote-spec.md).

export interface HostConfig {
  id: string;
  name: string;
  address: string;
  user?: string;
  port?: number;
  // Remote command line; empty means the default install location.
  command?: string;
}

export const DEFAULT_REMOTE_COMMAND = 'env ELECTRON_RUN_AS_NODE=1 "$HOME/.local/opt/tarmac/Tarmac" "$HOME/.local/opt/tarmac/resources/app/dist/cli.cjs" bridge';

export type FailureKind = 'unreachable' | 'hostkey' | 'auth' | 'missing' | 'version' | 'bridge';
export class RemoteFailure extends Error {
  readonly kind: FailureKind;
  readonly remoteVersion?: string;
  constructor(kind: FailureKind, message: string, remoteVersion?: string) {
    super(message);
    this.kind = kind;
    this.remoteVersion = remoteVersion;
  }
}

// Anything ssh could read as an option or a second word is refused before it reaches argv.
export function validHost(value: unknown): value is Omit<HostConfig, 'id'> {
  if (!value || typeof value !== 'object') return false;
  const host = value as Record<string, unknown>;
  return typeof host.name === 'string' && host.name.trim().length > 0 && host.name.length <= 64
    && typeof host.address === 'string' && /^[A-Za-z0-9_.%:[\]][A-Za-z0-9_.%:[\]-]{0,252}$/.test(host.address)
    && (host.user === undefined || (typeof host.user === 'string' && /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/.test(host.user)))
    && (host.port === undefined || (Number.isInteger(host.port) && (host.port as number) >= 1 && (host.port as number) <= 65535))
    && (host.command === undefined || (typeof host.command === 'string' && host.command.length <= 4096 && !/[\0\r\n]/.test(host.command)));
}

// Tarmac's own SSH files sit beside the user's in ~/.ssh with a tarmac_ prefix; none of the user's
// files is ever written (docs/app-remote-spec.md, first connection).
export interface SshFiles { key: string; publicKey: string; knownHosts: string; userKnownHosts: string }
export function sshFiles(dir = path.join(os.homedir(), '.ssh')): SshFiles {
  return { key: path.join(dir, 'tarmac_ed25519'), publicKey: path.join(dir, 'tarmac_ed25519.pub'),
    knownHosts: path.join(dir, 'tarmac_known_hosts'), userKnownHosts: path.join(dir, 'known_hosts') };
}

// ssh parses -o values like a config line: it splits on spaces and treats backslash as an escape.
// Windows paths use forward slashes, which OpenSSH for Windows accepts; a path with spaces is quoted.
export function optionPath(file: string, platform: NodeJS.Platform = process.platform): string {
  const value = platform === 'win32' ? file.replaceAll('\\', '/') : file;
  return /\s/.test(value) ? `"${value}"` : value;
}

export function sshArgs(host: Omit<HostConfig, 'id'>, files?: SshFiles): string[] {
  const own = files ? ['-o', `UserKnownHostsFile=${optionPath(files.knownHosts)} ${optionPath(files.userKnownHosts)}`,
    '-o', 'StrictHostKeyChecking=yes', ...(existsSync(files.key) ? ['-i', files.key] : [])] : [];
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    ...own, ...(host.port ? ['-p', String(host.port)] : []), '--', host.user ? `${host.user}@${host.address}` : host.address,
    host.command?.trim() || DEFAULT_REMOTE_COMMAND];
}

// ssh exits 255 for its own failures; the remote shell exits 127 for a missing command.
export function classifyExit(code: number | null, stderr: string): RemoteFailure {
  const text = stderr.trim();
  const last = text.split('\n').filter(Boolean).at(-1) ?? `ssh 退出码 ${code ?? '未知'}`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(text)) {
    return new RemoteFailure('hostkey', /CHANGED/.test(text) ? '主机指纹与已保存的不一致' : '还没有保存这台主机的指纹');
  }
  if (/Permission denied|Too many authentication failures|no mutual signature/i.test(text)) {
    return new RemoteFailure('auth', '密钥登录被拒绝：这台主机还不接受 Tarmac 的密钥');
  }
  if (/Could not resolve hostname|Connection refused|timed out|No route to host|Network is unreachable|Connection closed by|kex_exchange/i.test(text)) {
    return new RemoteFailure('unreachable', `无法连接：${last}`);
  }
  if (code === 127 || /command not found|No such file or directory|not found/i.test(text)) {
    return new RemoteFailure('missing', '这台主机上没有找到 Tarmac：先在那里安装 Tarmac（pnpm desktop:entry install --package），或在「远端命令」里填写实际位置');
  }
  return new RemoteFailure('bridge', `远端 bridge 失败：${last}`);
}

function parseHeader(line: string): BridgeHeader {
  const value = JSON.parse(line) as Partial<BridgeHeader>;
  if (value?.tarmacBridge !== 1 || typeof value.version !== 'string' || typeof value.protocol !== 'number'
    || (value.daemon !== 'running' && value.daemon !== 'started') || typeof value.home !== 'string'
    || typeof value.hostname !== 'string' || typeof value.shell?.command !== 'string' || !Array.isArray(value.shell.args)
    || !value.shell.args.every(arg => typeof arg === 'string')) throw new Error('invalid bridge header');
  return value as BridgeHeader;
}

export interface RemoteConnection { client: Client; header: BridgeHeader }
// appId: this App instance, sent when registering as a desktop (packages/daemon/src/session.ts attach).
export interface ConnectOptions { version: string; ssh?: string; headerTimeoutMs?: number; files?: SshFiles; appId?: string }

export function connectRemote(host: Omit<HostConfig, 'id'>, options: ConnectOptions): Promise<RemoteConnection> {
  const child = spawn(options.ssh ?? 'ssh', sshArgs(host, options.files ?? sshFiles()), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let pending = Buffer.alloc(0);
  let header: BridgeHeader | undefined;
  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk, _encoding, callback) {
      if (!child.stdin.writable) return callback(new Error('daemon disconnected'));
      child.stdin.write(chunk, callback);
    },
    final(callback) { child.stdin.end(); callback(); },
    destroy(error, callback) { if (child.exitCode === null && child.signalCode === null) child.kill(); callback(error); },
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => { clearTimeout(timer); stream.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new RemoteFailure('unreachable', '连接超时：远端没有在 15 秒内应答')), options.headerTimeoutMs ?? 15_000);
    child.once('error', error => fail(new RemoteFailure('unreachable', `无法运行 ssh：${error.message}`)));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.stdin.on('error', error => stream.destroy(error));
    child.stdout.on('data', (chunk: Buffer) => {
      if (header) { if (!stream.push(chunk)) child.stdout.pause(); return; }
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) { if (pending.length > 64 * 1024) fail(new RemoteFailure('bridge', '远端 bridge 输出无效')); return; }
      try { header = parseHeader(pending.subarray(0, newline).toString('utf8')); }
      catch { return fail(new RemoteFailure('bridge', '远端 bridge 输出无效')); }
      const rest = pending.subarray(newline + 1);
      pending = Buffer.alloc(0);
      clearTimeout(timer);
      if (header.version !== options.version || header.protocol !== VERSION) {
        return fail(new RemoteFailure('version', `两端版本不一致：本机 Tarmac ${options.version}，这台主机 ${header.version}。把两端升级到同一版本后再连接`, header.version));
      }
      if (rest.length) stream.push(rest);
      resolve({ client: Client.over(stream), header });
    });
    child.stdout.once('end', () => stream.push(null));
    child.once('close', code => {
      if (!header) fail(classifyExit(code, stderr));
      else stream.destroy();
    });
  });
}

// The socket listens before the daemon has loaded its registry; wait for a valid reply.
export async function untilReady(client: Client, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await client.request({ type: 'list' }, 2000); return; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'daemon initializing' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
