import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { Client } from '../../protocol/src/client.ts';
import { LIMITS } from '../../protocol/src/index.ts';
import type { HookEnvelope, Provider } from '../../protocol/src/index.ts';
import { ownedByCurrentUser, privateMode } from '../../protocol/src/platform.ts';

const execFileAsync = promisify(execFile);
type Environment = Record<string, string | undefined>;
export type FailureReason = 'invalid-payload' | 'unavailable' | 'timeout' | 'rejected';
export interface DeliveryResult { delivered: boolean; reason?: FailureReason; attempts: number }

export function parsePayload(data: Uint8Array, eventName?: 'StatusLine', provider?: Provider): Record<string, unknown> {
  if (data.byteLength > LIMITS.hookBytes) throw new Error('invalid-payload');
  const value: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-payload');
  const payload = value as Record<string, unknown>;
  if (eventName) payload.hook_event_name = eventName;
  // Antigravity sends protojson camelCase identity fields.
  if (provider === 'agy') {
    if (!payload.hook_event_name && typeof payload.hookEventName === 'string') payload.hook_event_name = payload.hookEventName;
    if (!payload.session_id && typeof payload.conversationId === 'string') payload.session_id = payload.conversationId;
  }
  if (typeof payload.hook_event_name !== 'string' || !payload.hook_event_name
    || typeof payload.session_id !== 'string' || !payload.session_id) throw new Error('invalid-payload');
  return payload;
}

export function normalizeHookPayload(provider: Provider, payload: Record<string, unknown>): Record<string, unknown> {
  if (provider === 'kimi') {
    const next = { ...payload };
    if (Array.isArray(next.prompt)) {
      next.prompt = next.prompt.map(part => {
        if (!part || typeof part !== 'object' || typeof part.type !== 'string') throw new Error('invalid-payload');
        if (part.type !== 'text') return '[附件]';
        if (typeof part.text !== 'string') throw new Error('invalid-payload');
        return part.text;
      }).join(' ');
    }
    if (typeof next.turn_id === 'number') {
      if (!Number.isSafeInteger(next.turn_id) || next.turn_id < 0) throw new Error('invalid-payload');
      next.turn_id = String(next.turn_id);
    }
    if (typeof next.tool_call_id === 'string' && next.tool_call_id) {
      if (next.tool_use_id !== undefined && next.tool_use_id !== next.tool_call_id) throw new Error('invalid-payload');
      next.tool_use_id = next.tool_call_id;
    }
    return next;
  }
  if (provider === 'agy') {
    const next = { ...payload };
    if (typeof next.lastUserInput === 'string' && !next.prompt) {
      next.prompt = next.lastUserInput;
    }
    if (typeof next.transcriptPath === 'string' && next.transcript_path === undefined) {
      next.transcript_path = next.transcriptPath;
    }
    if (next.toolCall && typeof next.toolCall === 'object' && !Array.isArray(next.toolCall)) {
      const tc = next.toolCall as Record<string, unknown>;
      if (typeof tc.id === 'string' && tc.id) next.tool_use_id = tc.id;
      if (typeof tc.name === 'string' && tc.name) next.tool_name = tc.name;
    }
    return next;
  }
  return payload;
}

export function readInput(input: NodeJS.ReadableStream, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
    };
    const fail = (reason: string) => { cleanup(); reject(new Error(reason)); };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > LIMITS.hookBytes) return fail('invalid-payload');
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const onError = () => fail('invalid-payload');
    const timer = setTimeout(() => fail('timeout'), Math.max(1, timeoutMs));
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}

export async function readPayload(input: NodeJS.ReadableStream, timeoutMs: number, provider?: Provider): Promise<Record<string, unknown>> {
  return parsePayload(await readInput(input, timeoutMs), undefined, provider);
}

interface ProcessEntry { pid: number; ppid: number; command: string; executable?: string }
export function findAgentAncestor(provider: Provider, entries: ProcessEntry[], startPid: number): number | undefined {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  const seen = new Set<number>();
  for (let pid = startPid; pid > 1 && !seen.has(pid);) {
    seen.add(pid);
    const entry = byPid.get(pid);
    if (!entry) return;
    const name = path.basename(entry.command).toLowerCase();
    const nativeKimi = provider === 'kimi' && entry.executable
      && ['kimi', 'kimi-cli', 'kimi-code'].includes(path.basename(entry.executable));
    if (name === provider || name === `${provider}-cli` || (provider === 'kimi' && name === 'kimi-code') || nativeKimi) return pid;
    pid = entry.ppid;
  }
}

export async function agentAncestor(provider: Provider, timeoutMs: number): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') {
      const entries: ProcessEntry[] = [];
      let pid = process.ppid;
      for (let count = 0; count < 24 && pid > 1; count++) {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const end = stat.lastIndexOf(')');
        const ppid = Number(stat.slice(end + 2).split(' ')[1]);
        const command = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        let executable: string | undefined;
        if (provider === 'kimi') {
          try { executable = readlinkSync(`/proc/${pid}/exe`); }
          catch { /* A verified command name may still identify the ancestor. */ }
        }
        entries.push({ pid, ppid, command, ...(executable ? { executable } : {}) });
        const found = findAgentAncestor(provider, entries, process.ppid);
        if (found) return found;
        if (ppid === pid) break;
        pid = ppid;
      }
      return findAgentAncestor(provider, entries, process.ppid);
    }
    if (process.platform === 'darwin') {
      const result = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm='], {
        timeout: Math.max(1, Math.min(60, timeoutMs)), maxBuffer: 4 * 1024 * 1024,
      });
      const entries = result.stdout.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
      });
      return findAgentAncestor(provider, entries, process.ppid);
    }
  } catch { /* Process identity is optional; never substitute the hook shell PID. */ }
}

export async function deliverHook(socketPath: string, event: HookEnvelope, timeoutMs: number = LIMITS.hookTimeoutMs, token?: string): Promise<DeliveryResult> {
  const deadline = performance.now() + timeoutMs;
  let reason: FailureReason = 'unavailable';
  let attempts = 0;
  while (attempts < 2 && deadline - performance.now() > 1) {
    attempts++;
    let client: Client | undefined;
    try {
      const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
      client = await Client.connect(socketPath, Math.min(100, remaining()), token);
      await client.request({ type: 'hook', event }, remaining());
      return { delivered: true, attempts };
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      reason = /timeout/.test(text) ? 'timeout' : /disconnected|ENOENT|ECONN|EPIPE/.test(text) ? 'unavailable' : 'rejected';
      if (reason === 'rejected') break;
    } finally { client?.close(); }
  }
  return { delivered: false, reason, attempts };
}

export function recordFailure(env: Environment, event: Pick<HookEnvelope, 'eventId' | 'sessionId' | 'instanceId' | 'provider'>, reason: FailureReason): void {
  const directory = env.TARMAC_HOOK_FAILURE_DIR;
  if (!directory || !path.isAbsolute(directory)) return;
  if (!/^[0-9a-f-]{36}$/i.test(event.eventId)
    || !/^[A-Za-z0-9_.:%-]{1,128}$/.test(event.sessionId)
    || !/^[A-Za-z0-9_.:%-]{1,128}$/.test(event.instanceId)) return;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat) || !ownedByCurrentUser(stat)) return;
    writeFileSync(path.join(directory, `${event.eventId}.json`), JSON.stringify({
      ...event, at: new Date().toISOString(), reason,
    }) + '\n', { mode: 0o600, flag: 'wx' });
  } catch { /* A missing failure directory must not delay or block the agent. */ }
}

export async function runHook(provider: Provider, input: NodeJS.ReadableStream, env: Environment = process.env): Promise<DeliveryResult> {
  const hookStartedAt = Date.now();
  const start = performance.now();
  const { TARMAC_SOCKET: socketPath, TARMAC_SESSION_ID: sessionId, TARMAC_INSTANCE_ID: instanceId } = env;
  if (!socketPath || !sessionId || !instanceId) { input.pause(); return { delivered: false, attempts: 0 }; }
  const identity = { eventId: randomUUID(), sessionId, instanceId, provider };
  try {
    const payload = normalizeHookPayload(provider, await readPayload(input, LIMITS.hookTimeoutMs, provider));
    const remaining = () => LIMITS.hookTimeoutMs - (performance.now() - start);
    const agentPid = await agentAncestor(provider, remaining());
    // Windows has no cheap ancestor walk here; the daemon resolves the agent from this PID.
    const hookPid = process.platform === 'win32' ? process.pid : undefined;
    const event: HookEnvelope = { ...identity, payload, hookStartedAt, ...(agentPid ? { agentPid } : {}), ...(hookPid ? { hookPid } : {}) };
    const result = await deliverHook(socketPath, event, Math.max(0, remaining()), env.TARMAC_TOKEN);
    if (!result.delivered) recordFailure(env, identity, result.reason ?? 'timeout');
    return result;
  } catch (error) {
    const reason = error instanceof Error && error.message === 'timeout' ? 'timeout' : 'invalid-payload';
    recordFailure(env, identity, reason);
    return { delivered: false, reason, attempts: 0 };
  }
}
