import { execFile } from 'node:child_process';
import { readFile, readlink, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { AgentKind, Foreground, Provider } from '../../protocol/src/index.ts';
import * as winproc from './winproc.ts';

const execFileAsync = promisify(execFile);
let pendingProcesses: Promise<ProcessEntry[]> | undefined;

function processSnapshot(): Promise<ProcessEntry[]> {
  if (pendingProcesses) return pendingProcesses;
  pendingProcesses = (process.platform === 'win32' ? winproc.snapshot() : execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,state=,comm='], {
    timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  }).then(({ stdout }) => stdout.split('\n').flatMap(line => {
    const value = parsePsLine(line); return value ? [value] : [];
  }))).finally(() => { pendingProcesses = undefined; });
  return pendingProcesses;
}
export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  state: string;
  command: string;
  argv?: string[];
  executable?: string;
  // Windows only (ms since epoch): parent links are checked against it because PIDs are reused.
  startedAt?: number;
}

export function parsePsLine(line: string): ProcessEntry | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  if (!match) return;
  return {
    pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
    tpgid: Number(match[4]), state: match[5], command: match[6],
  };
}

export function parseProcStat(text: string): ProcessEntry | undefined {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 1 || end < start) return;
  const pid = Number(text.slice(0, start).trim());
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (!Number.isInteger(pid) || fields.length < 6) return;
  const [ppid, pgid, tpgid] = [Number(fields[1]), Number(fields[2]), Number(fields[5])];
  if (![ppid, pgid, tpgid].every(Number.isInteger)) return;
  return { pid, ppid, pgid, tpgid, command: text.slice(start + 1, end), state: fields[0] };
}

function entryScript(argv: string[]): string | undefined {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (['-e', '--eval', '-p', '--print'].includes(arg) || /^--(?:eval|print)=/.test(arg)) return;
    if (['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(arg)) { index++; continue; }
    if (arg === '--') return argv[index + 1];
    if (arg.startsWith('-')) continue;
    return arg;
  }
}

const nodeName = (command: string) => /^node(?:js)?(?:\d+)?$/.test(path.basename(command));
function isNodeRuntime(entry: Pick<ProcessEntry, 'command' | 'argv'>): boolean {
  // Node 24 can expose MainThread as Linux comm. Verify argv[0] before
  // classifying its entry script; the thread name alone is not evidence.
  return nodeName(entry.command) || (path.basename(entry.command) === 'MainThread' && Boolean(entry.argv?.[0] && nodeName(entry.argv[0])));
}

const pythonName = (command: string) => /^python(?:\d+(?:\.\d+)?)?$/.test(path.basename(command));
export function providerFromProcess(entry: Pick<ProcessEntry, 'command' | 'argv' | 'executable'>): AgentKind | undefined {
  const name = path.basename(entry.command);
  // Bun can truncate both comm and argv[0] (observed kimi-cod in native ACP).
  // The actual executable is authoritative; a title prefix alone is not.
  if (entry.executable && ['kimi', 'kimi-cli', 'kimi-code'].includes(path.basename(entry.executable).replace(/\.exe$/i, ''))) return 'kimi';
  if (name === 'claude' || name === 'codex') return name;
  if (name === 'codex-ds' || name === 'codex-ark') return 'codex';
  if (name === 'kimi' || name === 'kimi-cli' || name === 'kimi-code') return 'kimi';
  if (name === 'agy') return 'agy';
  if (pythonName(entry.command) && entry.argv) {
    for (let index = 1; index < entry.argv.length; index++) {
      const arg = entry.argv[index];
      if (arg === '-c' || arg.startsWith('-c')) return;
      if (arg === '-m') return /^kimi_cli(?:\.__main__)?$/.test(entry.argv[index + 1] ?? '') ? 'kimi' : undefined;
      if (arg === '-W' || arg === '-X') { index++; continue; }
      if (arg === '--') {
        const script = entry.argv[index + 1] ?? '';
        return /(?:^|[\\/])(?:kimi(?:-cli)?|kimi_cli[\\/]__main__\.py)$/.test(script) ? 'kimi' : undefined;
      }
      if (arg.startsWith('-')) continue;
      return /(?:^|[\\/])(?:kimi(?:-cli)?|kimi_cli[\\/]__main__\.py)$/.test(arg) ? 'kimi' : undefined;
    }
    return;
  }
  if (!isNodeRuntime(entry) || !entry.argv) return;
  const script = entryScript(entry.argv)?.replaceAll('\\', '/');
  if (!script) return;
  if (/(?:^|\/)@openai\/codex\/(?:bin\/)?codex\.js$/.test(script)) return 'codex';
  if (/(?:^|\/)@anthropic-ai\/claude-code\/(?:cli|index)\.js$/.test(script)) return 'claude';
  if (/(?:^|\/)@moonshot-ai\/kimi-code\/dist\/main\.mjs$/.test(script)) return 'kimi';
}

export function codexProfile(entry: Pick<ProcessEntry, 'command' | 'argv'>): string | undefined {
  if (providerFromProcess(entry) !== 'codex') return;
  const argv = entry.argv ?? [];
  let profile: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') break;
    if (arg === '-p' || arg === '--profile') {
      const value = argv[++index];
      if (value && !value.startsWith('-')) profile = value;
    } else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length) || undefined;
    else if (/^-p[^-]/.test(arg)) profile = arg.slice(2);
    // Skip values belonging to other options, including values named -p.
    else if (['-c', '--config', '-m', '--model', '-C', '--cd', '-i', '--image', '--remote', '--remote-auth-token-env', '--enable', '--disable', '-a', '--ask-for-approval', '-s', '--sandbox', '--add-dir'].includes(arg)) index++;
  }
  return profile ?? ({ 'codex-ds': 'deepseek', 'codex-ark': 'ark' } as Record<string, string>)[path.basename(entry.command)];
}

function descendants(rootPid: number, entries: ProcessEntry[]): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  const result: ProcessEntry[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index];
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = byPid.get(pid);
    if (entry && !/^[TZ]/.test(entry.state)) result.push(entry);
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  return result;
}

export function selectForeground(rootPid: number, entries: ProcessEntry[]): ProcessEntry | undefined {
  const tree = descendants(rootPid, entries);
  const byPid = new Map(tree.map(entry => [entry.pid, entry]));
  const root = byPid.get(rootPid);
  if (!root || root.tpgid <= 0) return;
  const foregroundGroup = root.tpgid;
  const group = tree.filter(entry => entry.pgid === foregroundGroup);
  if (!group.length) return;
  // A foreground shell's ungrouped descendants may be background jobs. There is
  // no reliable evidence to promote one to the current agent in that case.
  if (foregroundGroup === root.pgid && !providerFromProcess(root)) return root;
  const eligible = new Set<number>();
  for (const entry of group) {
    let current: ProcessEntry | undefined = entry;
    while (current && !eligible.has(current.pid)) {
      eligible.add(current.pid);
      if (current.pid === rootPid) break;
      current = byPid.get(current.ppid);
    }
  }
  const candidates = tree.filter(entry => eligible.has(entry.pid) && providerFromProcess(entry));
  if (candidates.length) return pickAgent(candidates, byPid) ?? group.find(entry => entry.pid === foregroundGroup) ?? root;
  return group.find(entry => entry.pid === foregroundGroup) ?? group[0];
}

// Candidates in breadth-first order: this keeps a parent agent's tools/subagents from replacing it.
function pickAgent(candidates: ProcessEntry[], byPid: Map<number, ProcessEntry>): ProcessEntry | undefined {
  const first = candidates[0];
  const isBelowFirst = (entry: ProcessEntry) => {
    let current: ProcessEntry | undefined = entry;
    const seen = new Set<number>();
    while (current && !seen.has(current.pid)) {
      if (current.pid === first.pid) return true;
      seen.add(current.pid);
      current = byPid.get(current.ppid);
    }
    return false;
  };
  // Multiple sibling agents in a foreground pipeline have no unique owner.
  if (!candidates.every(isBelowFirst)) return;
  // The npm Codex launcher stays alive while its native child owns the
  // transcript and emits hooks. Only unwrap this exact launcher shape.
  if (isNodeRuntime(first) && providerFromProcess(first) === 'codex') {
    const native = candidates.filter(entry => entry.ppid === first.pid && path.basename(entry.command) === 'codex');
    if (native.length === 1) return native[0];
  }
  return first;
}

// The console hosts of a pseudoconsole are infrastructure, never the program in front.
const CONSOLE_HOSTS = new Set(['conhost', 'openconsole']);

// Windows has no terminal foreground process group. Agents are chosen by the same breadth-first
// rule; without an agent, a single chain of children is the running program, and any branching
// has no unique owner, so the shell itself is reported.
export function selectForegroundWindows(rootPid: number, entries: ProcessEntry[]): ProcessEntry | undefined {
  const tree = descendants(rootPid, entries).filter(entry => entry.pid === rootPid || !CONSOLE_HOSTS.has(entry.command));
  const byPid = new Map(tree.map(entry => [entry.pid, entry]));
  const root = byPid.get(rootPid);
  if (!root) return;
  const candidates = tree.filter(entry => providerFromProcess(entry));
  if (candidates.length) return pickAgent(candidates, byPid) ?? root;
  for (let current = root; ;) {
    const children = tree.filter(entry => entry.ppid === current.pid);
    if (children.length !== 1) return current;
    current = children[0];
  }
}

// Programs whose provider can only be told from argv or the executable path.
const needsDetails = (entry: ProcessEntry) => nodeName(entry.command) || pythonName(entry.command)
  || entry.command.startsWith('kimi') || ['codex', 'codex-ds', 'codex-ark'].includes(entry.command);

function describe(selected: ProcessEntry, tree: ProcessEntry[], cwd: string): Foreground {
  const provider = providerFromProcess(selected);
  const parent = tree.find(entry => entry.pid === selected.ppid);
  const profile = codexProfile(selected) ?? (provider === 'codex' && parent && isNodeRuntime(parent) ? codexProfile(parent) : undefined);
  return { pid: selected.pid, name: provider ?? path.basename(selected.command), cwd,
    ...(provider ? { provider } : {}), ...(profile ? { profile } : {}) };
}

async function foregroundWindows(rootPid: number, fallbackCwd: string): Promise<Foreground | undefined> {
  const tree = descendants(rootPid, await processSnapshot()).map(entry => ({ ...entry }));
  if (!tree.some(entry => entry.pid === rootPid)) return;
  // One helper round trip per probe: a PTY's tree is small, and the cwd of the selected
  // process is needed whichever one it turns out to be.
  const details = await winproc.inspect(tree.map(entry => entry.pid)).catch(() => new Map<number, winproc.WinDetails>());
  for (const entry of tree) {
    const found = details.get(entry.pid);
    if (found?.executable) entry.executable = found.executable;
    if (found?.argv && needsDetails(entry)) entry.argv = found.argv;
  }
  const selected = selectForegroundWindows(rootPid, tree);
  if (!selected) return;
  return describe(selected, tree, details.get(selected.pid)?.cwd ?? fallbackCwd);
}

// Windows hooks report their own PID; the nearest ancestor of the hook's provider is its agent.
export async function hookAgent(hookPid: number, provider: Provider): Promise<number | undefined> {
  if (process.platform !== 'win32') return;
  try {
    const byPid = new Map((await processSnapshot()).map(entry => [entry.pid, { ...entry }]));
    const chain: ProcessEntry[] = [];
    for (let pid = byPid.get(hookPid)?.ppid ?? 0; pid > 0 && chain.length < 24 && !chain.some(entry => entry.pid === pid);) {
      const entry = byPid.get(pid);
      if (!entry) break;
      chain.push(entry);
      pid = entry.ppid;
    }
    const details = await winproc.inspect(chain.filter(needsDetails).map(entry => entry.pid));
    for (const entry of chain) {
      const found = details.get(entry.pid);
      if (found?.executable) entry.executable = found.executable;
      if (found?.argv) entry.argv = found.argv;
      if (providerFromProcess(entry) === provider) return entry.pid;
    }
  } catch { /* Process identity is optional; the foreground provider check still applies. */ }
}

// Ends a PTY's remaining Windows process tree by its root PID.
export function killTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 4) return;
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
}

export function parseCommandLine(text: string): string[] {
  const args: string[] = [];
  let value = ''; let quote = ''; let active = false;
  for (const character of text.trim()) {
    if (quote) {
      if (character === quote) quote = '';
      else value += character;
      active = true;
    } else if (character === '"' || character === "'") { quote = character; active = true; }
    else if (/\s/.test(character)) { if (active) { args.push(value); value = ''; active = false; } }
    else { value += character; active = true; }
  }
  if (quote) return [];
  if (active) args.push(value);
  return args;
}

export function parseLsofCwd(text: string): string | undefined {
  const value = text.split('\n').find(line => line.startsWith('n'))?.slice(1);
  return value && path.isAbsolute(value) ? value : undefined;
}

let clockTicks: Promise<number> | undefined;
let bootTime: Promise<number> | undefined;

// Absolute start time in ms. Linux derives it from stat starttime and boot time,
// never from elapsed time, so repeated probes of one process return one value.
export async function processStartedAt(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    if (process.platform === 'win32') return (await processSnapshot()).find(entry => entry.pid === pid)?.startedAt || undefined;
    if (process.platform === 'linux') {
      clockTicks ??= execFileAsync('getconf', ['CLK_TCK'], { timeout: 500 })
        .then(result => Number(result.stdout.trim()) || 100, () => 100);
      bootTime ??= readFile('/proc/stat', 'utf8').then(text => {
        const value = Number(/^btime\s+(\d+)$/m.exec(text)?.[1]);
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error('boot time unavailable');
        return value * 1000;
      });
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[19]);
      if (!Number.isSafeInteger(ticks) || ticks < 0) return;
      return await bootTime + Math.round(ticks * 1000 / await clockTicks);
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='],
        { timeout: 500, env: { ...process.env, LC_ALL: 'C' } });
      const at = Date.parse(stdout.trim());
      return Number.isFinite(at) ? at : undefined;
    }
  } catch { /* A process can exit between the probe and this read. */ }
}

export async function openTranscript(pid: number, provider: Provider): Promise<string | undefined> {
  // Kimi's wire file is resolved only from an exact hook session ID; agy's transcript only from its hook path.
  if (provider === 'kimi' || provider === 'agy') return;
  let files: string[];
  try {
    if (process.platform === 'linux') {
      const directory = `/proc/${pid}/fd`;
      files = (await Promise.all((await readdir(directory)).map(name => readlink(`${directory}/${name}`).catch(() => ''))));
    } else if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-Fn'], { timeout: 500, maxBuffer: 1024 * 1024 });
      files = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    } else return;
  } catch { return; }
  const matches = [...new Set(files.filter(file => path.isAbsolute(file) && (provider === 'codex'
    ? /\/rollout-[^/]+-[0-9a-f-]{36}\.jsonl$/i.test(file)
    : /\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/i.test(file))))];
  // More than one main transcript has no unambiguous owner.
  return matches.length === 1 ? matches[0] : undefined;
}

export async function foreground(rootPid: number, fallbackCwd: string): Promise<Foreground | undefined> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return;
  try {
    if (process.platform === 'win32') return await foregroundWindows(rootPid, fallbackCwd);
    // Keep the shared host table immutable. Only this PTY's descendant tree
    // needs live stat/argv data, so avoid copying every host process per PTY.
    const entries = descendants(rootPid, await processSnapshot()).map(entry => ({ ...entry }));
    if (process.platform === 'linux') {
      const rootStat = parseProcStat(await readFile(`/proc/${rootPid}/stat`, 'utf8'));
      if (!rootStat) return;
      const root = entries.find(entry => entry.pid === rootPid);
      if (!root) return;
      Object.assign(root, rootStat);
    }
    const tree = descendants(rootPid, entries);
    await Promise.all(tree.map(async entry => {
      if (process.platform === 'linux' && (path.basename(entry.command).startsWith('kimi') || path.basename(entry.command) === 'MainThread')) {
        try { entry.executable = await readlink(`/proc/${entry.pid}/exe`); }
        catch { /* Disappearing or inaccessible processes retain conservative classification. */ }
      }
      if (!nodeName(entry.command) && !pythonName(entry.command) && !['MainThread', 'codex', 'codex-ds', 'codex-ark'].includes(path.basename(entry.command))) return;
      try {
        if (process.platform === 'linux') entry.argv = (await readFile(`/proc/${entry.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        else if (process.platform === 'darwin') {
          const result = await execFileAsync('ps', ['-p', String(entry.pid), '-o', 'command='], { timeout: 500, maxBuffer: 64 * 1024 });
          entry.argv = parseCommandLine(result.stdout);
        }
      } catch { /* A process can exit between the process snapshot and inspection. */ }
    }));
    const selected = selectForeground(rootPid, entries);
    if (!selected) return;
    let cwd = fallbackCwd;
    try {
      if (process.platform === 'linux') cwd = await readlink(`/proc/${selected.pid}/cwd`);
      else if (process.platform === 'darwin') {
        const result = await execFileAsync('lsof', ['-a', '-p', String(selected.pid), '-d', 'cwd', '-Fn'], { timeout: 500, maxBuffer: 64 * 1024 });
        cwd = parseLsofCwd(result.stdout) ?? fallbackCwd;
      }
    } catch { /* Missing inspection permissions preserve the known launch directory. */ }
    return describe(selected, tree, cwd);
  } catch { return undefined; }
}
