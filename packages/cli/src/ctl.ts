import path from 'node:path';
import type { Readable } from 'node:stream';
import { Client } from '../../protocol/src/client.ts';
import { defaultDataDir, readEndpoint } from '../../protocol/src/platform.ts';
import { REMOTE_ERRORS, REMOTE_KEYS, REMOTE_ORIGIN, REMOTE_SCREEN_LINES, REMOTE_TEXT_BYTES } from '../../protocol/src/index.ts';
import type { RemoteKey, Request } from '../../protocol/src/index.ts';

// `tarmac ctl`: external control for local programs. Contract (arguments, JSON fields, error codes) is
// docs/tarmac-ctl.md. stdout carries exactly one JSON line; text arrives on stdin only and
// never reaches argv, stderr or logs. Inherited TARMAC_* variables are ignored: the daemon is found
// by data directory alone, and it is never started from here.

export type CtlCode = 'unavailable' | 'unsupported' | 'stale' | 'rejected' | 'invalid' | 'failed';
export type CtlResult = { ok: true; [field: string]: unknown } | { ok: false; code: CtlCode; message: string };

class CtlError extends Error {
  readonly code: CtlCode;
  constructor(code: CtlCode, message: string) { super(message); this.code = code; }
}
const invalid = (message: string) => new CtlError('invalid', message);

interface Parsed { flags: Map<string, string[]>; command: string[] }

// Every option takes a value except the listed switches; `--` ends options (create's argv follows).
function parse(args: string[], allowed: string[], switches: string[] = []): Parsed {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return { flags, command: args.slice(index + 1) };
    if (!allowed.includes(arg) && !switches.includes(arg)) throw invalid(`unexpected argument ${arg.startsWith('--') ? arg : '(positional)'}`);
    if (switches.includes(arg)) { flags.set(arg, ['']); continue; }
    const value = args[++index];
    if (value === undefined) throw invalid(`${arg} needs a value`);
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  return { flags, command: [] };
}
function single(parsed: Parsed, name: string): string | undefined {
  const values = parsed.flags.get(name);
  if (values && values.length > 1) throw invalid(`${name} given more than once`);
  return values?.[0];
}
function required(parsed: Parsed, name: string): string {
  const value = single(parsed, name);
  if (!value) throw invalid(`${name} is required`);
  return value;
}
function identity(parsed: Parsed): { sessionId: string; instanceId: string } {
  const sessionId = required(parsed, '--session');
  const instanceId = required(parsed, '--instance');
  return { sessionId, instanceId };
}
function pid(parsed: Parsed): number {
  const value = required(parsed, '--expect-pid');
  const number = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 1) throw invalid('--expect-pid must be a process id');
  return number;
}

async function readText(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > REMOTE_TEXT_BYTES) throw invalid('text exceeds 1 MiB');
    chunks.push(buffer);
  }
  if (!bytes) throw invalid('text is empty');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw invalid('text is not UTF-8'); }
}

// Requests and the shape of their successful output, after local argument checks.
async function prepare(sub: string, args: string[], stdin: Readable):
  Promise<{ request: Request; timeoutMs: number; output: (value: unknown) => Record<string, unknown>; dataDir?: string }> {
  const common = ['--data-dir'];
  const ok = () => ({});
  switch (sub) {
    case 'list': {
      const parsed = parse(args, common);
      return { request: { type: 'remote-list' }, timeoutMs: 5000, output: value => ({ sessions: value }), dataDir: single(parsed, '--data-dir') };
    }
    case 'screen': {
      const parsed = parse(args, [...common, '--session', '--instance', '--lines'], ['--no-join']);
      const raw = single(parsed, '--lines') ?? '30';
      const lines = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
      if (!(lines >= 1 && lines <= REMOTE_SCREEN_LINES)) throw invalid(`--lines must be 1-${REMOTE_SCREEN_LINES}`);
      return { request: { type: 'remote-screen', ...identity(parsed), lines, join: !parsed.flags.has('--no-join') },
        timeoutMs: 5000, output: value => value as Record<string, unknown>, dataDir: single(parsed, '--data-dir') };
    }
    case 'text': {
      const parsed = parse(args, [...common, '--session', '--instance', '--expect-pid']);
      const target = { ...identity(parsed), expectPid: pid(parsed) };
      return { request: { type: 'remote-text', ...target, text: await readText(stdin) }, timeoutMs: 5000, output: ok,
        dataDir: single(parsed, '--data-dir') };
    }
    case 'key': {
      const parsed = parse(args, [...common, '--session', '--instance', '--expect-pid', '--key']);
      const keys = parsed.flags.get('--key') ?? [];
      if (!keys.length) throw invalid('--key is required');
      const unknown = keys.find(key => !(REMOTE_KEYS as readonly string[]).includes(key));
      if (unknown !== undefined) throw invalid(`unknown key; allowed: ${REMOTE_KEYS.join(', ')}`);
      return { request: { type: 'remote-key', ...identity(parsed), expectPid: pid(parsed), keys: keys as RemoteKey[] },
        timeoutMs: 5000, output: ok, dataDir: single(parsed, '--data-dir') };
    }
    case 'create': {
      const parsed = parse(args, [...common, '--cwd', '--origin']);
      const cwd = required(parsed, '--cwd');
      if (!path.isAbsolute(cwd)) throw invalid('--cwd must be an absolute directory');
      const origin = single(parsed, '--origin');
      if (origin !== undefined && !REMOTE_ORIGIN.test(origin)) throw invalid('--origin must match [a-z0-9-]{1,32}');
      const [command, ...rest] = parsed.command;
      if (!command) throw invalid('the program follows --');
      return { request: { type: 'remote-create', cwd, command, args: rest, ...(origin ? { origin } : {}) }, timeoutMs: 8000,
        output: value => ({ session: value }), dataDir: single(parsed, '--data-dir') };
    }
    case 'close': {
      const parsed = parse(args, [...common, '--session', '--instance', '--expect-pid']);
      return { request: { type: 'remote-close', ...identity(parsed), expectPid: pid(parsed) }, timeoutMs: 5000, output: ok,
        dataDir: single(parsed, '--data-dir') };
    }
    default: throw invalid('subcommand must be list, screen, text, key, create or close');
  }
}

function daemonError(message: string): CtlError {
  if (message === REMOTE_ERRORS.stale) return new CtlError('stale', 'session or instance is gone; refresh the list');
  if (message === REMOTE_ERRORS.rejected) return new CtlError('rejected', 'expected process is not in the foreground');
  if (message === REMOTE_ERRORS.invalid) return invalid('daemon rejected the arguments');
  if (message === 'unknown request type') return new CtlError('unsupported', 'Tarmac daemon is too old for ctl; restart the App');
  if (message === 'daemon initializing' || message === 'daemon shutting down' || message === 'daemon disconnected') {
    return new CtlError('unavailable', message);
  }
  return new CtlError('failed', message);
}

export async function runCtl(args: string[], stdin: Readable): Promise<CtlResult> {
  try {
    const [sub, ...rest] = args;
    const { request, timeoutMs, output, dataDir } = await prepare(sub ?? '', rest, stdin);
    if (dataDir !== undefined && !path.isAbsolute(dataDir)) throw invalid('--data-dir must be absolute');
    let endpoint;
    try { endpoint = readEndpoint(path.resolve(dataDir ?? defaultDataDir())); }
    catch { throw new CtlError('unavailable', 'no daemon endpoint for this data directory'); }
    let client: Client;
    try { client = await Client.connect(endpoint.path, 2000, endpoint.token); }
    catch { throw new CtlError('unavailable', 'Tarmac daemon is not running'); }
    try {
      const value = await client.request(request, timeoutMs).catch(error => { throw daemonError(error instanceof Error ? error.message : ''); });
      return { ok: true, ...output(value) };
    } finally { client.close(); }
  } catch (error) {
    if (error instanceof CtlError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'failed', message: 'ctl failed' };
  }
}
