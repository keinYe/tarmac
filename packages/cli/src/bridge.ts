import net from 'node:net';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from '../../protocol/src/index.ts';
import { defaultDataDir, endpointPath } from '../../protocol/src/platform.ts';
import { defaultShell, type ShellCommand } from '../../protocol/src/shell.ts';

// `tarmac bridge`: run over SSH by another machine's App (docs/app-remote-spec.md). It writes one
// header line, then copies bytes unchanged between stdio and this machine's daemon socket. The
// daemon gains no network listener; SSH login is the access control.

export interface BridgeHeader {
  tarmacBridge: 1;
  version: string;
  protocol: number;
  daemon: 'running' | 'started';
  shell: ShellCommand;
  home: string;
  hostname: string;
}

export interface BridgeOptions {
  version: string;
  // Starts a detached daemon for this data directory; it must outlive the bridge.
  startDaemon(dataDir: string): void;
  stdin: Readable;
  stdout: Writable;
  dataDir?: string;
  startTimeoutMs?: number;
}

// The environment of a daemon the bridge starts; agents inherit it. Variables of a Tarmac session
// the bridge may run in are dropped, and so are the SSH session's: SSH_CLIENT and SSH_CONNECTION
// name the connecting machine, SSH_AUTH_SOCK would hand agents a forwarded agent.
export function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('TARMAC_') && !name.startsWith('SSH_')));
}

function connect(file: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
    socket.once('error', reject);
  });
}

export async function runBridge(options: BridgeOptions): Promise<void> {
  // A Windows daemon listens on a named pipe that requires a token; remote hosts are POSIX.
  if (process.platform === 'win32') throw new Error('tarmac bridge runs only on Linux or macOS');
  const dataDir = options.dataDir ?? defaultDataDir();
  const file = endpointPath(dataDir);
  let daemon: BridgeHeader['daemon'] = 'running';
  let socket = await connect(file).catch(() => undefined);
  if (!socket) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    options.startDaemon(dataDir);
    daemon = 'started';
    const deadline = Date.now() + (options.startTimeoutMs ?? 5000);
    while (!socket) {
      if (Date.now() >= deadline) throw new Error('daemon did not start');
      await delay(100);
      socket = await connect(file).catch(() => undefined);
    }
  }
  const header: BridgeHeader = { tarmacBridge: 1, version: options.version, protocol: VERSION, daemon,
    shell: defaultShell(), home: os.homedir(), hostname: os.hostname() };
  options.stdout.write(JSON.stringify(header) + '\n');
  const connection = socket;
  await new Promise<void>(resolve => {
    connection.on('error', () => {});
    connection.once('close', () => resolve());
    // The App closing SSH ends stdin; ending the socket lets the daemon drop this peer.
    options.stdin.once('end', () => connection.end());
    options.stdin.once('error', () => connection.destroy());
    options.stdin.pipe(connection, { end: false });
    connection.pipe(options.stdout, { end: false });
  });
}
