import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import type { ProcessEntry } from './process.ts';

// Client of `tarmac-native proc` (cmd/tarmac-native): a long-lived Windows helper that answers
// JSON lines on stdin/stdout. Spawning PowerShell per 500 ms probe is too slow and wmic is gone
// from Windows 11, so the process table, command lines and working directories come from it.

export interface WinDetails { pid: number; argv?: string[]; cwd?: string; executable?: string }
interface RawProcess { pid?: unknown; ppid?: unknown; name?: unknown; startedAt?: unknown }

const TIMEOUT_MS = 1000;

export function helperPath(env: NodeJS.ProcessEnv = process.env, script: string | undefined = process.argv[1]): string {
  return env.TARMAC_NATIVE || path.join(path.dirname(script ?? ''), 'native', 'tarmac-native.exe');
}

// Image names are case-insensitive on Windows; the provider rules match lower-case stems.
export const programName = (file: string): string => path.win32.basename(file).replace(/\.exe$/i, '').toLowerCase();

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

// A Windows parent PID is not cleared when the parent exits and can be reused by a later process.
// An edge whose parent started after the child, or whose parent is gone, is not a parent link.
export function normalizeSnapshot(raw: unknown): ProcessEntry[] {
  if (!Array.isArray(raw)) throw new Error('invalid process snapshot');
  const entries: ProcessEntry[] = [];
  for (const item of raw as RawProcess[]) {
    if (!item || !positive(item.pid) || !Number.isSafeInteger(item.ppid) || typeof item.name !== 'string' || !item.name) continue;
    const startedAt = positive(item.startedAt) ? item.startedAt : 0;
    entries.push({ pid: item.pid, ppid: item.ppid as number, pgid: 0, tpgid: 0, state: 'R', command: programName(item.name), startedAt });
  }
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  for (const entry of entries) {
    const parent = byPid.get(entry.ppid);
    if (!parent || parent.pid === entry.pid || !parent.startedAt || !entry.startedAt || parent.startedAt > entry.startedAt) entry.ppid = 0;
  }
  return entries;
}

export function normalizeDetails(raw: unknown): WinDetails[] {
  if (!Array.isArray(raw)) throw new Error('invalid process details');
  return raw.flatMap((item: Record<string, unknown> | null) => {
    if (!item || !positive(item.pid)) return [];
    const details: WinDetails = { pid: item.pid };
    if (Array.isArray(item.argv) && item.argv.length && item.argv.every(arg => typeof arg === 'string')) details.argv = item.argv as string[];
    if (typeof item.cwd === 'string' && path.win32.isAbsolute(item.cwd)) details.cwd = item.cwd.replace(/(?<=[^:\\])\\$/, '');
    if (typeof item.executable === 'string' && path.win32.isAbsolute(item.executable)) details.executable = item.executable;
    return [details];
  });
}

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

class Helper {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private pending = new Map<number, Pending>();
  private next = 1;
  private buffer = '';
  dead = false;

  constructor(file: string) {
    this.child = spawn(file, ['proc'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    // The helper must never keep a stopping daemon alive; it exits when its stdin closes.
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout] as unknown as { unref?: () => void }[]) stream.unref?.();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        let reply: Record<string, unknown>;
        try { reply = JSON.parse(line); } catch { this.fail(new Error('invalid helper reply')); return; }
        const task = this.pending.get(Number(reply.id));
        if (!task) continue;
        this.pending.delete(Number(reply.id));
        clearTimeout(task.timer);
        if (typeof reply.error === 'string') task.reject(new Error(reply.error));
        else task.resolve(reply);
      }
      if (this.buffer.length > 16 * 1024 * 1024) this.fail(new Error('helper reply exceeds limit'));
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('process helper exited')));
    this.child.stdin.on('error', () => {});
  }

  request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error('process helper exited'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('process helper timeout')); }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...message, id }) + '\n');
    });
  }

  fail(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

let helper: Helper | undefined;
// A crashed helper is replaced on the next call; callers degrade to "unknown" meanwhile.
const current = (): Helper => (helper && !helper.dead ? helper : (helper = new Helper(helperPath())));

export async function snapshot(): Promise<ProcessEntry[]> {
  return normalizeSnapshot((await current().request({ op: 'snapshot' })).processes);
}

export async function inspect(pids: number[]): Promise<Map<number, WinDetails>> {
  if (!pids.length) return new Map();
  const details = normalizeDetails((await current().request({ op: 'inspect', pids })).items);
  return new Map(details.map(item => [item.pid, item]));
}

export function stopHelper(): void {
  helper?.fail(new Error('process helper stopped'));
  helper = undefined;
}
