import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryView, HookEnvelope, InputRecord, Provider } from '../../protocol/src/index.ts';
import { LIMITS } from '../../protocol/src/index.ts';
import { syncsDirectories } from '../../protocol/src/platform.ts';
import { isPromptEvent, isSubagentEvent } from './state.ts';

interface JournalEntry {
  v: 1;
  eventId: string;
  provider: Provider;
  agentSessionId: string;
  eventName: string;
  at: string;
  seq: number;
  prompt?: string;
  tarmacSessionId?: string;
}
interface Group { records: InputRecord[]; capturedSince: string }
function key(provider: Provider, sessionId: string): string { return JSON.stringify([provider, sessionId]); }
function readKey(provider: Provider, sessionId: string, tarmacSessionId?: string): string {
  return tarmacSessionId ? JSON.stringify([provider, sessionId, tarmacSessionId]) : key(provider, sessionId);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validProvider(value: unknown): value is Provider { return value === 'claude' || value === 'codex' || value === 'kimi' || value === 'agy'; }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

// One daemon owns this store. ACK is allowed only after accept has resolved.
export class HistoryStore {
  private dataDir: string;
  private journalPath: string;
  private readPath: string;
  private groups = new Map<string, Group>();
  private seen = new Set<string>();
  private reads = new Map<string, number>();
  private seq = 0;
  private initialized = false;
  private poisoned = false;
  private error: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.journalPath = join(dataDir, 'events.jsonl');
    this.readPath = join(dataDir, 'read.json');
  }

  get lastError(): string | undefined { return this.error; }
  hasEvent(eventId: string): boolean { return this.seen.has(eventId); }

  async initialize(): Promise<void> {
    return this.serialize(async () => {
      this.initialized = false;
      try {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        let data: Buffer;
        try { data = await readFile(this.journalPath); }
        catch (error) { if (!absent(error)) throw error; data = Buffer.alloc(0); }
        const lastNewline = data.lastIndexOf(10);
        const usableBytes = data.length === 0 ? 0 : lastNewline + 1;
        const truncated = usableBytes !== data.length;
        const groups = new Map<string, Group>();
        const seen = new Set<string>();
        let lastSeq = 0;
        for (const line of data.subarray(0, usableBytes).toString('utf8').split('\n')) {
          if (line === '') continue;
          const entry = JSON.parse(line) as JournalEntry;
          if (entry.v !== 1 || !text(entry.eventId) || !validProvider(entry.provider)
            || !text(entry.agentSessionId) || !text(entry.eventName) || !text(entry.at)
            || !Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq || seen.has(entry.eventId)
            || (entry.prompt !== undefined && typeof entry.prompt !== 'string')
            || (entry.tarmacSessionId !== undefined && !text(entry.tarmacSessionId))) throw new Error('invalid input journal entry');
          seen.add(entry.eventId);
          lastSeq = entry.seq;
          this.applyEntry(groups, entry);
        }
        const reads = new Map<string, number>();
        try {
          const saved = JSON.parse(await readFile(this.readPath, 'utf8')) as { v: number; read: unknown[] };
          if (saved.v !== 1 || !Array.isArray(saved.read)) throw new Error('invalid reading positions');
          for (const raw of saved.read) {
            const item = raw as { provider: Provider; sessionId: string; seq: number; tarmacSessionId?: string };
            if (!validProvider(item.provider) || !text(item.sessionId) || !Number.isSafeInteger(item.seq) || item.seq < 0) throw new Error('invalid reading position');
            const group = groups.get(key(item.provider, item.sessionId));
            if (item.tarmacSessionId !== undefined && !text(item.tarmacSessionId)) throw new Error('invalid reading position');
            const records = item.tarmacSessionId ? group?.records.filter(record => record.tarmacSessionId === item.tarmacSessionId) : group?.records;
            const maximum = records?.at(-1)?.seq ?? 0;
            reads.set(readKey(item.provider, item.sessionId, item.tarmacSessionId), Math.min(item.seq, maximum));
          }
        } catch (error) { if (!absent(error)) throw error; }
        // Sync a complete unacknowledged tail before allowing a retry to be acknowledged.
        const handle = await open(this.journalPath, 'a+', 0o600);
        try {
          if (truncated) await handle.truncate(usableBytes);
          await handle.sync();
        } finally { await handle.close(); }
        await this.syncDirectory();
        this.groups = groups;
        this.seen = seen;
        this.reads = reads;
        this.seq = lastSeq;
        this.error = truncated ? '日志末尾不完整，已保留此前完整记录；末尾未确认投递可能缺失' : undefined;
        this.poisoned = false;
        this.initialized = true;
      } catch (error) {
        this.error = `输入记录初始化失败：${message(error)}`;
        this.poisoned = true;
        throw error;
      }
    });
  }

  async accept(event: HookEnvelope): Promise<{ duplicate: boolean }> {
    return this.serialize(async () => {
      this.ready();
      if (!text(event.eventId) || !validProvider(event.provider) || !text(event.instanceId) || !text(event.sessionId)
        || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('invalid hook envelope');
      const p = event.payload;
      if (!text(p.session_id) || !text(p.hook_event_name)) throw new Error('hook requires session_id and hook_event_name');
      if (Buffer.byteLength(JSON.stringify(p)) > LIMITS.hookBytes) throw new Error('hook payload exceeds limit');
      if (this.seen.has(event.eventId)) return { duplicate: true };
      if (p.hook_event_name === 'UserPromptSubmit' && typeof p.prompt !== 'string') throw new Error('prompt event requires prompt text');
      const entry: JournalEntry = {
        v: 1, eventId: event.eventId, provider: event.provider, agentSessionId: p.session_id,
        eventName: p.hook_event_name, at: new Date().toISOString(), seq: this.seq + 1,
        tarmacSessionId: event.sessionId,
      };
      if (isPromptEvent(event.provider, p) && !isSubagentEvent(p) && typeof p.prompt === 'string') entry.prompt = p.prompt;
      await this.append(entry);
      return { duplicate: false };
    });
  }

  // Input read from an agent's own log where no hook exists (shared-daemon Codex rollout).
  // eventId must be stable for that input so a re-read never records it twice.
  async acceptPrompt(input: { eventId: string; provider: Provider; agentSessionId: string; at: string; prompt: string;
    tarmacSessionId: string }): Promise<{ duplicate: boolean }> {
    return this.serialize(async () => {
      this.ready();
      if (!text(input.eventId) || !validProvider(input.provider) || !text(input.agentSessionId) || !text(input.tarmacSessionId)
        || !text(input.at) || !Number.isFinite(Date.parse(input.at)) || typeof input.prompt !== 'string'
        || Buffer.byteLength(input.prompt) > LIMITS.hookBytes) throw new Error('invalid input record');
      if (this.seen.has(input.eventId)) return { duplicate: true };
      await this.append({ v: 1, eventId: input.eventId, provider: input.provider, agentSessionId: input.agentSessionId,
        eventName: 'RolloutUserMessage', at: input.at, seq: this.seq + 1, prompt: input.prompt, tarmacSessionId: input.tarmacSessionId });
      return { duplicate: false };
    });
  }

  private async append(entry: JournalEntry): Promise<void> {
    try {
      const handle = await open(this.journalPath, 'a', 0o600);
      try {
        await handle.writeFile(JSON.stringify(entry) + '\n');
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) {
      // Do not append a duplicate after a partial write or a failed fsync.
      this.poisoned = true;
      this.error = `输入记录写入失败，投递未确认：${message(error)}`;
      throw error;
    }
    this.seq = entry.seq;
    this.seen.add(entry.eventId);
    this.applyEntry(this.groups, entry);
  }

  view(provider: Provider, agentSessionId: string, tarmacSessionId?: string): HistoryView {
    const groupKey = key(provider, agentSessionId);
    const group = this.groups.get(groupKey);
    const readSeq = this.reads.get(readKey(provider, agentSessionId, tarmacSessionId)) ?? 0;
    const records = tarmacSessionId ? group?.records.filter(record => record.tarmacSessionId === tarmacSessionId) : group?.records;
    return {
      records: (records ?? []).map(record => ({ ...record })), readSeq,
      unread: records?.filter(record => record.seq > readSeq).length ?? 0,
      capturedSince: group?.capturedSince, error: this.error,
    };
  }

  async markRead(provider: Provider, agentSessionId: string, seq: number, tarmacSessionId?: string): Promise<void> {
    return this.serialize(async () => {
      this.ready();
      if (!validProvider(provider) || !text(agentSessionId) || !Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid reading position');
      const groupKey = readKey(provider, agentSessionId, tarmacSessionId);
      const group = this.groups.get(key(provider, agentSessionId));
      const records = tarmacSessionId ? group?.records.filter(record => record.tarmacSessionId === tarmacSessionId) : group?.records;
      const maximum = records?.at(-1)?.seq ?? 0;
      const bounded = Math.min(seq, maximum);
      const next = new Map(this.reads);
      next.set(groupKey, Math.max(next.get(groupKey) ?? 0, bounded));
      const read = [...next].map(([group, position]) => {
        const [provider, sessionId, tarmacSessionId] = JSON.parse(group) as [Provider, string, string?];
        return { provider, sessionId, tarmacSessionId, seq: position };
      });
      const temp = join(this.dataDir, `read-${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ v: 1, read }) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, this.readPath);
        await this.syncDirectory();
      } catch (error) {
        this.error = `阅读位置保存失败：${message(error)}`;
        throw error;
      }
      this.reads = next;
    });
  }

  private applyEntry(groups: Map<string, Group>, entry: JournalEntry): void {
    const groupKey = key(entry.provider, entry.agentSessionId);
    let group = groups.get(groupKey);
    if (!group) { group = { records: [], capturedSince: entry.at }; groups.set(groupKey, group); }
    if (entry.prompt !== undefined) group.records.push({
      eventId: entry.eventId, provider: entry.provider, agentSessionId: entry.agentSessionId,
      at: entry.at, seq: entry.seq, prompt: entry.prompt,
      ...(entry.tarmacSessionId ? { tarmacSessionId: entry.tarmacSessionId } : {}),
    });
  }
  private ready(): void {
    if (!this.initialized || this.poisoned) throw new Error(this.error ?? 'input history is not initialized');
  }
  private async syncDirectory(): Promise<void> {
    if (!syncsDirectories()) return;
    const directory = await open(this.dataDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
