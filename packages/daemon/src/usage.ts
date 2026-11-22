import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Provider, TokenUsage, HookEnvelope } from '../../protocol/src/index.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('token 计数无效');
  return value as number;
};
type Counts = Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens'>;

// One reader owns one exact conversation in one observed process. It never picks
// a transcript by cwd, modification time, or another process's latest session.
export class UsageReader {
  readonly provider: Provider;
  readonly agentRunId: string;
  readonly file: string;
  readonly expectedSessionId?: string;
  private sessionId: string | undefined;
  private offset = 0;
  private inode = '';
  private modified = 0;
  private pending = Buffer.alloc(0);
  private messages = new Map<string, Counts>();
  private totals: Counts | undefined;
  private rateLimits: TokenUsage['rateLimits'];
  private failure: Error | undefined;
  // Kimi may skip its Stop hook; the same exact-session wire log records turn ends.
  private turnEnds = new Map<number, { reason: string; time: number }>();
  private reading: Promise<TokenUsage | undefined> | undefined;

  constructor(provider: Provider, agentRunId: string, file: string, sessionId?: string) {
    if (!path.isAbsolute(file)) throw new Error('会话记录路径无效');
    if (provider === 'kimi' && (!sessionId || path.basename(file) !== 'wire.jsonl'
      || path.basename(path.dirname(file)) !== 'main' || path.basename(path.dirname(path.dirname(file))) !== 'agents'
      || path.basename(path.dirname(path.dirname(path.dirname(file)))) !== sessionId)) throw new Error('Kimi 记录与当前会话路径不匹配');
    // agy: <brain>/<conversationId>/.system_generated/logs/transcript_full.jsonl; rows carry no conversation ID.
    if (provider === 'agy' && (!sessionId || path.basename(file) !== 'transcript_full.jsonl'
      || path.basename(path.dirname(file)) !== 'logs' || path.basename(path.dirname(path.dirname(file))) !== '.system_generated'
      || path.basename(path.dirname(path.dirname(path.dirname(file)))) !== sessionId)) throw new Error('agy 记录与当前会话路径不匹配');
    this.provider = provider;
    this.agentRunId = agentRunId;
    this.file = file;
    this.expectedSessionId = sessionId;
    this.sessionId = sessionId;
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.messages.clear();
    this.totals = undefined;
    this.rateLimits = undefined;
    this.failure = undefined;
    this.turnEnds.clear();
    this.sessionId = this.expectedSessionId;
  }

  kimiTurnEnd(turnId: number): { reason: string; time: number } | undefined {
    return this.turnEnds.get(turnId);
  }

  private identify(id: unknown): void {
    if (typeof id !== 'string' || !id) throw new Error('会话记录缺少 ID');
    if (this.sessionId && id !== this.sessionId) throw new Error('token 记录与当前会话不匹配');
    this.sessionId = id;
  }

  private line(buffer: Buffer): void {
    if (this.failure || !buffer.length) return;
    try {
      const row = object(JSON.parse(buffer.toString('utf8')));
      if (!row) return;
      if (this.provider === 'kimi') {
        if (row.type === 'turn.ended') {
          if ((row.agentId === undefined || row.agentId === 'main') && Number.isSafeInteger(row.turnId)
            && typeof row.reason === 'string' && Number.isSafeInteger(row.time)) {
            this.turnEnds.delete(row.turnId as number);
            this.turnEnds.set(row.turnId as number, { reason: row.reason, time: row.time as number });
            if (this.turnEnds.size > 32) this.turnEnds.delete(this.turnEnds.keys().next().value!);
          }
          return;
        }
        if (row.type !== 'usage.record') return;
        if (!this.sessionId) throw new Error('token 记录缺少会话关联');
        const usage = object(row.usage);
        if (!usage) return;
        if (!['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'].some(key => usage[key] !== undefined)) return;
        const cacheReadTokens = count(usage.inputCacheRead ?? 0);
        const cacheWriteTokens = count(usage.inputCacheCreation ?? 0);
        const inputTokens = count(count(usage.inputOther ?? 0) + cacheReadTokens + cacheWriteTokens);
        const outputTokens = count(usage.output ?? 0);
        const next = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: count(inputTokens + outputTokens) };
        const totals = this.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
        for (const key of Object.keys(next) as (keyof Counts)[]) totals[key] = count(totals[key] + next[key]);
        this.totals = totals;
      } else if (this.provider === 'codex') {
        const payload = object(row.payload);
        if (row.type === 'session_meta') { this.identify(payload?.id); return; }
        if (row.type !== 'event_msg' || payload?.type !== 'token_count') return;
        if (!this.sessionId) throw new Error('token 记录缺少会话关联');
        const limits = object(payload.rate_limits);
        // Independent pools (for example Spark) must not overwrite the account
        // limits. Quota-only events can update the last cumulative token total.
        if (limits?.limit_id === 'codex') {
          const windows = [limits.primary, limits.secondary].flatMap(value => {
            const bucket = object(value);
            if (!bucket || !Number.isSafeInteger(bucket.window_minutes) || (bucket.window_minutes as number) <= 0
              || typeof bucket.used_percent !== 'number' || !Number.isFinite(bucket.used_percent)
              || bucket.used_percent < 0 || bucket.used_percent > 100
              || !Number.isSafeInteger(bucket.resets_at) || (bucket.resets_at as number) <= 0
              || !Number.isFinite(new Date((bucket.resets_at as number) * 1000).getTime())) return [];
            return [{ windowMinutes: bucket.window_minutes as number, usedPercent: bucket.used_percent,
              resetsAt: bucket.resets_at as number }];
          });
          const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
          if (Number.isFinite(at) && (!this.rateLimits || at >= Date.parse(this.rateLimits.observedAt))) {
            this.rateLimits = windows.length ? { observedAt: new Date(at).toISOString(), windows } : undefined;
          }
        }
        const usage = object(object(payload.info)?.total_token_usage);
        if (!usage) return;
        const inputTokens = count(usage.input_tokens);
        const outputTokens = count(usage.output_tokens);
        const cacheReadTokens = count(usage.cached_input_tokens ?? 0);
        const cacheWriteTokens = count(usage.cache_write_input_tokens ?? 0);
        if (cacheReadTokens + cacheWriteTokens > inputTokens) throw new Error('缓存 token 计数无效');
        this.totals = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
          totalTokens: count(usage.total_tokens ?? inputTokens + outputTokens) };
      } else if (this.provider === 'agy') {
        // One PLANNER_RESPONSE step per model call; input_tokens excludes cache_read_tokens.
        if (row.type !== 'PLANNER_RESPONSE' || row.source !== 'MODEL'
          || !['input_tokens', 'output_tokens', 'cache_read_tokens'].some(key => row[key] !== undefined)) return;
        if (!Number.isSafeInteger(row.step_index) || (row.step_index as number) < 0) throw new Error('token 记录缺少步骤序号');
        const cacheReadTokens = count(row.cache_read_tokens ?? 0);
        const inputTokens = count(count(row.input_tokens ?? 0) + cacheReadTokens);
        const outputTokens = count(row.output_tokens ?? 0);
        this.messages.set(String(row.step_index), { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0,
          totalTokens: count(inputTokens + outputTokens) });
        this.totals = undefined;
      } else {
        if (row.type !== 'assistant' || row.isSidechain === true) return;
        const message = object(row.message);
        const usage = object(message?.usage);
        if (!usage) return;
        this.identify(row.sessionId);
        if (typeof message?.id !== 'string' || !message.id) throw new Error('token 记录缺少消息 ID');
        const cacheReadTokens = count(usage.cache_read_input_tokens ?? 0);
        const cacheWriteTokens = count(usage.cache_creation_input_tokens ?? 0);
        const inputTokens = count(count(usage.input_tokens) + cacheReadTokens + cacheWriteTokens);
        const outputTokens = count(usage.output_tokens);
        this.messages.set(message.id, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
          totalTokens: count(inputTokens + outputTokens) });
        this.totals = undefined;
      }
    } catch (error) { this.failure = error instanceof Error ? error : new Error('无法解析 token 记录'); }
  }

  // Callers may overlap (hook and status-line events skip the poll interval). Offset and
  // pending bytes belong to one pass, so a concurrent caller shares the pass in flight.
  read(): Promise<TokenUsage | undefined> {
    this.reading ??= this.readOnce().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async readOnce(): Promise<TokenUsage | undefined> {
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NONBLOCK);
    let caughtUp = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('会话记录不是普通文件');
      const inode = `${stat.dev}:${stat.ino}`;
      if (inode !== this.inode || stat.size < this.offset
        || (stat.size === this.offset && stat.mtimeMs !== this.modified)) this.reset();
      this.inode = inode;
      this.modified = stat.mtimeMs;
      // Bound each poll's IO and memory; large first loads catch up over later polls.
      let budget = 4 * 1024 * 1024;
      while (this.offset < stat.size && budget > 0 && !this.failure) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - this.offset, budget));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        budget -= bytesRead;
        const data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (;;) {
          const end = data.indexOf(10, start);
          if (end < 0) break;
          this.line(data.subarray(start, end));
          start = end + 1;
        }
        this.pending = Buffer.from(data.subarray(start));
        if (this.pending.length > 8 * 1024 * 1024) this.failure = new Error('会话记录单行超过读取上限');
      }
      caughtUp = this.offset === stat.size;
    } finally { await handle.close(); }
    if (this.failure) throw this.failure;
    if (!caughtUp || !this.sessionId) return;
    if ((this.provider === 'claude' || this.provider === 'agy') && this.messages.size && !this.totals) {
      this.totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
      for (const message of this.messages.values()) {
        for (const key of Object.keys(this.totals) as (keyof Counts)[]) this.totals[key] = count(this.totals[key] + message[key]);
      }
    }
    if (!this.totals) return;
    return { provider: this.provider, agentRunId: this.agentRunId, agentSessionId: this.sessionId, ...this.totals,
      ...(this.rateLimits ? { rateLimits: this.rateLimits } : {}) };
  }
}

// Fallback counts only delivered request attempts; a transcript always replaces
// this partial view rather than being added to it (resume history is unknown).
export class HookUsage {
  private events = new Set<string>();
  private usage: TokenUsage | undefined;

  reset(): void { this.events.clear(); this.usage = undefined; }
  get view(): TokenUsage | undefined { return this.usage ? { ...this.usage } : undefined; }

  apply(event: HookEnvelope, agentRunId: string): void {
    if (event.provider !== 'codex' || event.payload.hook_event_name !== 'PostModelRequest'
      || this.events.has(event.eventId)) return;
    const usage = object(event.payload.token_usage);
    const sessionId = event.payload.session_id;
    if (!usage || typeof sessionId !== 'string' || !sessionId) return;
    try {
      const inputTokens = count(usage.input_tokens);
      const outputTokens = count(usage.output_tokens);
      const cacheReadTokens = count(usage.cached_input_tokens ?? 0);
      const cacheWriteTokens = count(usage.cache_write_input_tokens ?? 0);
      if (cacheReadTokens + cacheWriteTokens > inputTokens) return;
      const next = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: count(inputTokens + outputTokens) };
      const previous = this.usage;
      if (previous && (previous.agentSessionId !== sessionId || previous.agentRunId !== agentRunId)) return;
      if (previous) for (const key of Object.keys(next) as (keyof Counts)[]) next[key] = count(next[key] + previous[key]);
      this.events.add(event.eventId);
      this.usage = { provider: 'codex', agentSessionId: sessionId, agentRunId, scope: 'observed', ...next };
    } catch { /* Missing/invalid per-attempt counts must not corrupt existing data. */ }
  }
}
