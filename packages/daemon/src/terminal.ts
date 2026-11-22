import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { LIMITS, VERSION, validSize } from '../../protocol/src/index.ts';
import type { Identity, ReplayView, ServerEvent } from '../../protocol/src/index.ts';
import { TerminalFramer } from './framer.ts';
import { ReplayLog, verifyCheckpoint } from './replay.ts';

export interface ReplayLimits { compactBytes: number; retryBytes: number; maxBytes: number }
type SnapshotFrame = Extract<ServerEvent, { type: 'snapshot' }>;
type StreamFrame = Extract<ServerEvent, { type: 'output' | 'resize' }>;

export class TerminalStream {
  // Authoritative emulator: answers terminal queries and supplies checkpoint candidates.
  readonly terminal: InstanceType<typeof headless.Terminal>;
  private addon: InstanceType<typeof serialize.SerializeAddon>;
  private framer = new TerminalFramer();
  private log: ReplayLog;
  private limits: ReplayLimits;
  private nextCheck: number;
  private checking: Promise<void> | undefined;
  private lastCheckFailure: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private queuedBytes = 0;
  private paused = false;
  private disposed = false;
  private failure: Error | undefined;
  private identity: Identity;
  private appended: () => void;
  private changed: () => void;
  private flow: (paused: boolean) => void;

  constructor(identity: Identity, cols: number, rows: number, options: {
    // Called after records join the replay log, so subscribers can be pumped.
    appended?: () => void;
    // Called when the replay view (exactness, check failure) changes.
    changed?: () => void;
    reply?: (data: string) => void;
    flow?: (paused: boolean) => void;
    limits?: Partial<ReplayLimits>;
  } = {}) {
    if (!validSize(cols, rows)) throw new Error('invalid terminal size');
    this.identity = identity;
    this.appended = options.appended ?? (() => {});
    this.changed = options.changed ?? (() => {});
    this.flow = options.flow ?? (() => {});
    this.limits = { compactBytes: LIMITS.replayCompactBytes, retryBytes: LIMITS.replayRetryBytes, maxBytes: LIMITS.replayMaxBytes, ...options.limits };
    this.nextCheck = this.limits.compactBytes;
    this.terminal = new headless.Terminal({ cols, rows, scrollback: LIMITS.scrollback, allowProposedApi: true });
    this.addon = new serialize.SerializeAddon();
    this.terminal.loadAddon(this.addon);
    this.terminal.onData(data => options.reply?.(data));
    this.log = new ReplayLog({ seq: 0, cols, rows, data: '', exact: true });
  }

  get seq(): number { return this.sequence; }
  get pendingBytes(): number { return this.framer.pendingBytes; }
  get logBytes(): number { return this.log.bytes; }
  get replay(): ReplayView {
    const base = this.log.base;
    return { exact: base.exact, reason: base.reason, lastCheckFailure: this.lastCheckFailure };
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let complete: Buffer;
    try { complete = this.framer.push(bytes); }
    catch (error) { this.failure = error as Error; return Promise.reject(error); }
    if (!complete.length) return Promise.resolve();
    this.queuedBytes += complete.length;
    if (this.queuedBytes >= LIMITS.parseHighBytes && !this.paused) { this.paused = true; this.flow(true); }
    return this.schedule(async () => {
      try {
        await new Promise<void>(resolve => this.terminal.write(complete, resolve));
        this.log.append({ seq: ++this.sequence, kind: 'output', data: complete });
        this.compact();
        this.appended();
      } finally {
        this.queuedBytes -= complete.length;
        if (this.paused && this.queuedBytes <= LIMITS.parseLowBytes) { this.paused = false; this.flow(false); }
      }
    });
  }

  resize(cols: number, rows: number, resizePty?: () => void): Promise<void> {
    if (!validSize(cols, rows)) return Promise.reject(new Error('invalid terminal size'));
    return this.schedule(async () => {
      resizePty?.();
      this.terminal.resize(cols, rows);
      this.log.append({ seq: ++this.sequence, kind: 'resize', cols, rows });
      this.appended();
    });
  }

  // Replay base plus the log end at this barrier; later records follow via read().
  snapshot(accept: (snapshot: SnapshotFrame) => void): Promise<void> {
    return this.schedule(async () => {
      const base = this.log.base;
      accept({ v: VERSION, type: 'snapshot', ...this.identity, seq: base.seq, cols: base.cols, rows: base.rows,
        data: Buffer.from(base.data).toString('base64'), target: this.log.end, exact: base.exact });
    });
  }

  // Frames after `after` totalling about limitBytes of output; undefined when the subscriber fell
  // behind the base.
  read(after: number, limitBytes: number, maxFrames: number): { event: StreamFrame; bytes: number }[] | undefined {
    return this.log.read(after, Math.min(limitBytes, LIMITS.replayFrameBytes), maxFrames, limitBytes)?.map(frame => frame.kind === 'output'
      ? { event: { v: VERSION, type: 'output', ...this.identity, first: frame.first, seq: frame.seq, data: frame.data.toString('base64') }, bytes: frame.data.length }
      : { event: { v: VERSION, type: 'resize', ...this.identity, seq: frame.seq, cols: frame.cols, rows: frame.rows }, bytes: 0 });
  }

  async idle(): Promise<void> {
    await this.queue;
    await this.checking;
  }
  // Resolves once every output written so far has been parsed, without waiting for a checkpoint.
  drained(): Promise<void> { return this.schedule(async () => {}); }
  dispose(): void { this.disposed = true; this.terminal.dispose(); }

  // Runs inside the parse queue, so the headless state matches log.end exactly.
  private compact(): void {
    const log = this.log;
    const overLimit = log.bytes >= this.limits.maxBytes;
    if (!overLimit && (log.bytes < this.nextCheck || this.checking)) return;
    const candidate = { seq: this.sequence, cols: this.terminal.cols, rows: this.terminal.rows, data: this.addon.serialize() };
    if (!log.base.exact || overLimit) {
      // Degradation is sticky: a reference rebuilt from an inexact base proves nothing.
      const reason = log.base.reason ?? `回放日志达到 ${Math.round(this.limits.maxBytes / 1048576)} MiB 上限，${this.lastCheckFailure ?? '终端状态'}未能验证`;
      log.rebase({ ...candidate, exact: false, reason });
      this.nextCheck = this.limits.compactBytes;
      this.changed();
      return;
    }
    const base = log.base;
    const records = log.through(candidate.seq);
    this.checking = verifyCheckpoint(base, records, candidate)
      .catch(error => ({ ok: false as const, reason: `验证出错：${error instanceof Error ? error.message : String(error)}` }))
      .then(result => {
        this.checking = undefined;
        if (this.disposed || this.log.base !== base) return;
        if (result.ok) {
          this.log.rebase({ ...candidate, exact: true });
          this.nextCheck = this.limits.compactBytes;
          this.lastCheckFailure = undefined;
        } else {
          this.lastCheckFailure = result.reason;
          this.nextCheck = this.log.bytes + this.limits.retryBytes;
        }
        this.changed();
        // Subscribers behind the new base learn about it on their next read.
        this.appended();
      });
  }

  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
}
