import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentView } from '../../protocol/src/index.ts';
import { LIMITS } from '../../protocol/src/index.ts';

// Shared `codex app-server` runs threads and hooks outside the PTY, so a TUI
// client has no hook identity or open rollout. This module associates a PTY
// with a rollout only on unique evidence (see docs/app-hooks-usage.md).

export const START_BEFORE_MS = 2000;
export const START_AFTER_MS = 60_000;
export const SUBMIT_WINDOW_MS = 5000;
const RELEVANT_MS = 90_000;
const ENTER_RETENTION_MS = 15_000;
const SCAN_DAYS = 7;
const META_LIMIT = 2 * 1024 * 1024;
const TAIL_BUDGET = 4 * 1024 * 1024;
const TURN_LIMIT = 64;

export interface RolloutTurn { id?: string; kind: 'started' | 'complete' | 'aborted'; at: number; user: boolean }
export interface RolloutPrompt { id: string; at: number; text: string }
export interface RolloutFile { home: string; file: string; id: string; cwd: string; createdAt: number; turns: RolloutTurn[];
  prompts: RolloutPrompt[] }
export interface RolloutRun { key: string; home: string; pid: number; cwd: string; startedAt: number; enters: number[] }
export interface RolloutBinding { file: string; id: string; from: number; pid: number }

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Top-level interactive TUI threads only: review/guardian and other subagent
// threads carry a subagent source or a parent thread and are never candidates.
export function parseRolloutMeta(line: string, home: string, file: string): RolloutFile | undefined {
  let row: Record<string, unknown> | undefined;
  try { row = object(JSON.parse(line)); } catch { return; }
  const meta = object(row?.payload);
  if (row?.type !== 'session_meta' || !meta) return;
  if (meta.originator !== 'codex-tui' || meta.parent_thread_id !== undefined || meta.forked_from_id !== undefined) return;
  if (object(meta.source)?.subagent !== undefined) return;
  const createdAt = typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : NaN;
  if (typeof meta.id !== 'string' || !meta.id || typeof meta.cwd !== 'string' || !path.isAbsolute(meta.cwd)
    || !Number.isFinite(createdAt)) return;
  return { home, file, id: meta.id, cwd: meta.cwd, createdAt, turns: [], prompts: [] };
}

// What the user typed: Codex 0.170 marks it with retained_source; injected
// AGENTS.md and environment context carry no such source and are skipped.
export function parseRolloutPrompt(line: string): RolloutPrompt | undefined {
  if (!line.includes('"response_item"') || !line.includes('"retained_source"')) return;
  let row: Record<string, unknown> | undefined;
  try { row = object(JSON.parse(line)); } catch { return; }
  const payload = object(row?.payload);
  const source = object(object(row?.metadata)?.retained_source);
  const id = object(source?.id)?.message_id;
  const at = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  if (row?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user' || !source
    || source.complete === false || typeof id !== 'string' || !id || !Number.isFinite(at) || !Array.isArray(payload.content)) return;
  const text = payload.content.map(object)
    .filter(part => (part?.type === 'input_text' || part?.type === 'text') && typeof part.text === 'string' && part.text)
    .map(part => part!.text as string).join('\n');
  if (!text.trim() || Buffer.byteLength(text) > LIMITS.hookBytes) return;
  return { id, at, text };
}

export function parseRolloutTurn(line: string): RolloutTurn | undefined {
  if (!line.includes('"event_msg"') || !/"(task_started|task_complete|turn_aborted)"/.test(line)) return;
  let row: Record<string, unknown> | undefined;
  try { row = object(JSON.parse(line)); } catch { return; }
  const payload = object(row?.payload);
  const at = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  if (row?.type !== 'event_msg' || !payload || !Number.isFinite(at)) return;
  const kind = payload.type === 'task_started' ? 'started' : payload.type === 'task_complete' ? 'complete'
    : payload.type === 'turn_aborted' ? 'aborted' : undefined;
  if (!kind) return;
  const trigger = object(payload.turn_attribution)?.turn_trigger;
  return { kind, at, id: typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : undefined,
    user: trigger === undefined || trigger === 'user' };
}

// Pure association step. Previous bindings survive while their process lives;
// a user submit can rebind (resume, /new); start evidence applies only after its
// window closes, so a rollout that appears late cannot be confused with another.
export function bindRollouts(runs: RolloutRun[], files: RolloutFile[], previous: Map<string, RolloutBinding>,
  now: number): Map<string, RolloutBinding> {
  const next = new Map<string, RolloutBinding>();
  for (const run of runs) {
    const kept = previous.get(run.key);
    if (kept && kept.pid === run.pid && files.some(f => f.file === kept.file && f.home === run.home && f.cwd === run.cwd)) {
      next.set(run.key, kept);
    }
  }
  const claimedByOther = (file: string, key: string) => [...next].some(([other, binding]) => other !== key && binding.file === file);
  const local = (run: RolloutRun) => files.filter(f => f.home === run.home && f.cwd === run.cwd);

  for (const run of runs) {
    for (const enter of [...run.enters].sort((a, b) => a - b)) {
      // An Enter inside the bound thread's open turn answers a menu or adds input;
      // it never starts another thread, so it cannot move the binding.
      const current = next.get(run.key);
      const currentFile = current && files.find(f => f.file === current.file);
      if (current && currentFile && openTurnAt(currentFile, current.from, enter)) continue;
      const starts = local(run).filter(f => !claimedByOther(f.file, run.key)).flatMap(f => f.turns
        .filter(t => t.kind === 'started' && t.user && t.at >= enter && t.at <= enter + SUBMIT_WINDOW_MS)
        .map(t => ({ f, t })));
      const owners = new Set(starts.map(s => s.f.file));
      if (owners.size !== 1) continue;
      const competing = runs.some(other => other.key !== run.key && other.home === run.home && other.cwd === run.cwd
        && other.enters.some(x => starts.some(s => x <= s.t.at && s.t.at - x <= SUBMIT_WINDOW_MS)));
      if (competing) continue;
      const file = starts[0].f;
      if (next.get(run.key)?.file !== file.file) next.set(run.key, { file: file.file, id: file.id, from: enter, pid: run.pid });
    }
  }

  for (const run of runs) {
    if (next.has(run.key) || now <= run.startedAt + START_AFTER_MS) continue;
    const inWindow = (f: RolloutFile, r: RolloutRun) =>
      f.createdAt >= r.startedAt - START_BEFORE_MS && f.createdAt <= r.startedAt + START_AFTER_MS;
    const candidates = local(run).filter(f => !claimedByOther(f.file, run.key) && inWindow(f, run));
    if (candidates.length !== 1) continue;
    const rivals = runs.some(other => other.key !== run.key && !next.has(other.key) && other.home === run.home
      && other.cwd === run.cwd && inWindow(candidates[0], other));
    if (rivals) continue;
    next.set(run.key, { file: candidates[0].file, id: candidates[0].id, from: run.startedAt - START_BEFORE_MS, pid: run.pid });
  }
  return next;
}

function openTurnAt(file: RolloutFile, from: number, at: number): boolean {
  let open = false;
  let id: string | undefined;
  for (const turn of file.turns) {
    if (turn.at < from || turn.at > at) continue;
    if (turn.kind === 'started') { open = true; id = turn.id; } else if (!id || !turn.id || turn.id === id) open = false;
  }
  return open;
}

// Turns before the binding point are history and never change the state.
export function rolloutActivity(file: RolloutFile, from: number): Pick<AgentView, 'activity' | 'reason' | 'turnId'> {
  let open: string | undefined;
  let result: Pick<AgentView, 'activity' | 'reason' | 'turnId'> = { activity: 'running', reason: 'awaiting_activity_evidence' };
  for (const turn of file.turns) {
    if (turn.at < from) continue;
    if (turn.kind === 'started') {
      open = turn.id;
      result = { activity: 'working', turnId: turn.id };
    } else if (!open || !turn.id || turn.id === open) {
      result = turn.kind === 'complete' ? { activity: 'waiting', turnId: turn.id }
        : { activity: 'running', reason: 'turn_interrupted', turnId: turn.id };
      open = undefined;
    }
  }
  return result;
}

const APPROVAL_QUESTIONS = [
  'Would you like to run the following command?',
  'Would you like to make the following edits?',
  'Would you like to grant these permissions?',
  'Would you like to send input to the existing terminal?',
];

// Codex 0.169 approval overlay: one of its questions together with a Yes/No
// option line near the bottom. Model output that merely quotes one phrase is
// not enough to mark a pending permission.
export function codexApprovalOnScreen(lines: string[]): boolean {
  const tail = lines.map(line => line.trim()).filter(Boolean).slice(-20);
  const question = tail.some(line => APPROVAL_QUESTIONS.some(q => line.includes(q)));
  const option = tail.some(line => /^(?:[›>❯▶]\s*)?(?:\d+[.)]\s*)?(?:Yes|No),\s/.test(line));
  return question && option;
}

interface Tracked {
  inode: string;
  // undefined: idle since first sight, metadata not read yet; null: not a candidate.
  meta: RolloutFile | null | undefined;
  // -1 until metadata decides whether a file active at first sight is read from the start.
  offset: number;
  pending: string;
}

export class RolloutIndex {
  readonly home: string;
  private tracked = new Map<string, Tracked>();

  constructor(home: string) { this.home = home; }

  async refresh(now: number, keep: Set<string>): Promise<RolloutFile[]> {
    const seen = new Set<string>();
    const result: RolloutFile[] = [];
    for (let day = 0; day < SCAN_DAYS; day++) {
      const date = new Date(now - day * 86_400_000);
      const dir = path.join(this.home, 'sessions', String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
      let names: string[];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!/^rollout-.+\.jsonl$/.test(name)) continue;
        const file = path.join(dir, name);
        let info;
        try { info = await stat(file); } catch { continue; }
        if (!info.isFile()) continue;
        seen.add(file);
        const relevant = info.mtimeMs >= now - RELEVANT_MS || keep.has(file);
        const inode = `${info.dev}:${info.ino}`;
        let entry = this.tracked.get(file);
        if (!entry || entry.inode !== inode || info.size < entry.offset) {
          // An idle file remembers its size, so the first rows a later resume appends
          // (the user's task_started among them) are read rather than skipped.
          entry = { inode, meta: undefined, pending: '', offset: relevant ? -1 : info.size };
          this.tracked.set(file, entry);
        }
        if (!relevant) continue;
        if (entry.meta === undefined) {
          entry.meta = await this.readMeta(file);
          // A file already active at first sight: older resumed files only contribute appends from now on.
          if (entry.offset < 0) entry.offset = entry.meta && entry.meta.createdAt >= now - 2 * RELEVANT_MS ? 0 : info.size;
        }
        if (!entry.meta) continue;
        await this.tail(file, entry, info.size);
        result.push(entry.meta);
      }
    }
    for (const file of this.tracked.keys()) if (!seen.has(file)) this.tracked.delete(file);
    return result;
  }

  private async readMeta(file: string): Promise<RolloutFile | null> {
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return null;
    try {
      const buffer = Buffer.alloc(Math.min(META_LIMIT, 64 * 1024));
      let data = Buffer.alloc(0);
      let position = 0;
      while (data.length < META_LIMIT) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        data = Buffer.concat([data, buffer.subarray(0, bytesRead)]);
        const end = data.indexOf(10);
        if (end >= 0) return parseRolloutMeta(data.subarray(0, end).toString('utf8'), this.home, file) ?? null;
      }
      return null;
    } catch { return null; } finally { await handle.close(); }
  }

  private async tail(file: string, entry: Tracked, size: number): Promise<void> {
    if (entry.offset >= size) return;
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return;
    try {
      const length = Math.min(size - entry.offset, TAIL_BUDGET);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, entry.offset);
      entry.offset += bytesRead;
      const lines = (entry.pending + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      entry.pending = lines.pop() ?? '';
      if (entry.pending.length > 8 * 1024 * 1024) entry.pending = '';
      const meta = entry.meta!;
      for (const line of lines) {
        const turn = parseRolloutTurn(line);
        if (turn) meta.turns.push(turn);
        const prompt = parseRolloutPrompt(line);
        if (prompt && !meta.prompts.some(p => p.id === prompt.id)) meta.prompts.push(prompt);
      }
      if (meta.turns.length > TURN_LIMIT) meta.turns.splice(0, meta.turns.length - TURN_LIMIT);
      if (meta.prompts.length > TURN_LIMIT) meta.prompts.splice(0, meta.prompts.length - TURN_LIMIT);
    } catch { /* A rotating or vanished file is retried on the next refresh. */ } finally { await handle.close(); }
  }
}

// Host-wide: uniqueness is decided across every shared-mode Codex PTY at once.
export class CodexRolloutTracker {
  private runs = new Map<string, RolloutRun>();
  private indexes = new Map<string, RolloutIndex>();
  private bindings = new Map<string, RolloutBinding>();
  private files = new Map<string, RolloutFile>();
  private refreshing: Promise<void> | undefined;
  private refreshedAt = 0;

  report(run: RolloutRun): void { this.runs.set(run.key, run); }

  remove(key: string): void {
    this.runs.delete(key);
    this.bindings.delete(key);
  }

  async resolve(key: string, now = Date.now()): Promise<{ binding: RolloutBinding; file: RolloutFile } | undefined> {
    if (!this.runs.has(key)) return;
    if (now - this.refreshedAt >= 900) {
      this.refreshing ??= this.refresh(now).finally(() => { this.refreshing = undefined; });
      await this.refreshing;
    }
    const binding = this.bindings.get(key);
    const file = binding && this.files.get(binding.file);
    return binding && file ? { binding, file } : undefined;
  }

  private async refresh(now: number): Promise<void> {
    for (const run of this.runs.values()) run.enters = run.enters.filter(at => at >= now - ENTER_RETENTION_MS);
    const runs = [...this.runs.values()];
    const files: RolloutFile[] = [];
    for (const home of new Set(runs.map(run => run.home))) {
      let index = this.indexes.get(home);
      if (!index) this.indexes.set(home, index = new RolloutIndex(home));
      const keep = new Set([...this.bindings.values()].map(binding => binding.file));
      files.push(...await index.refresh(now, keep));
    }
    for (const home of this.indexes.keys()) if (!runs.some(run => run.home === home)) this.indexes.delete(home);
    this.files = new Map(files.map(file => [file.file, file]));
    this.bindings = bindRollouts(runs, files, this.bindings, now);
    this.refreshedAt = now;
  }
}
