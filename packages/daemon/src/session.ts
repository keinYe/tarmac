import path from 'node:path';
import os from 'node:os';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { VERSION, LIMITS, REMOTE_ERRORS, SESSION_BUSY, validSize, isHookProvider, SNAPSHOT_PART_CHARS, base64Bytes } from '../../protocol/src/index.ts';
import type { CreateOptions, HookEnvelope, Provider, RemoteKey, RemoteSession, ServerFrame, SessionInfo, Identity, TokenUsage } from '../../protocol/src/index.ts';
import { TerminalStream } from './terminal.ts';
import { keyBytes, pasteBytes, screenText } from './remote.ts';
import type { ReplayLimits } from './terminal.ts';
import { IdleClock, StateTracker, isSubagentEvent } from './state.ts';
import type { HistoryStore } from './history.ts';
import { foreground, hookAgent, killTree, openTranscript, processStartedAt } from './process.ts';
import { codexApprovalOnScreen, rolloutActivity } from './codex-rollout.ts';
import type { CodexRolloutTracker, RolloutBinding, RolloutFile } from './codex-rollout.ts';
import { UsageReader, HookUsage } from './usage.ts';
import { claudeAccountOf, claudeTranscript, claudeRateLimits, claudeSnapshotLimits } from './claude-usage.ts';
import type { ClaudeAccountQuota } from './claude-usage.ts';
import { kimiHome, kimiTranscript } from './kimi-usage.ts';
import type { KimiQuota } from './kimi-quota.ts';
import type { UploadStore } from './uploads.ts';
import { inspectHookConfig } from '../../cli/src/inspect.ts';
import type { Peer } from './peer.ts';
import { subFor } from './peer.ts';

export interface SessionHost {
  readonly dataDir: string;
  readonly socketPath: string;
  readonly token: string | undefined;
  readonly history: HistoryStore;
  readonly codexRollouts: CodexRolloutTracker;
  readonly kimiQuota: KimiQuota;
  readonly claudeQuota: ClaudeAccountQuota;
  readonly uploads: UploadStore;
  // daemon.log: metadata only, never conversation content or paths.
  log(message: string): void;
  // Tests shrink the compaction thresholds; production uses the protocol limits.
  readonly replayLimits?: Partial<ReplayLimits>;
  persist(): Promise<void>;
  broadcast(context: SessionContext): void;
  pump(context: SessionContext): void;
  send(peer: Peer, frame: ServerFrame): void;
  releaseControl(sessionId: string): void;
  allowUsage(context: SessionContext, provider: Provider, agentSessionId: string): boolean;
}

interface RegistryEntry {
  session: SessionInfo;
  selectedHistory?: { provider: Provider; id: string; tarmacSessionId?: string };
}

export const USAGE_RETRY_MS = 10_000;

// What the diagnostics may say about a failed read: a file system code or the reader's own fixed
// message. A JSON parse error quotes the line, so it is reduced to its kind.
export function usageFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  if (error instanceof SyntaxError) return '会话记录有一行不是合法 JSON';
  return error instanceof Error && error.message ? error.message.slice(0, 60) : '未知错误';
}

export class SessionContext {
  readonly sessionId: string;
  readonly instanceId: string;
  info: SessionInfo;
  private child: pty.IPty | undefined;
  readonly ended: Promise<void>;
  private resolveEnded: () => void;
  private stream: TerminalStream | undefined;
  private readonly state = new StateTracker();
  private selectedHistory: RegistryEntry['selectedHistory'];
  private usageConversation: { provider: Provider; id: string } | undefined;
  private probeTimer: Promise<void> | undefined;
  private probeKnown = false;
  private usageReader: UsageReader | undefined;
  private readonly hookUsage = new HookUsage();
  private statusLimits: { sessionId: string; file: string; limits: TokenUsage['rateLimits'] } | undefined;
  private hookTranscript: { provider: Provider; agentRunId: string; agentSessionId: string; file: string } | undefined;
  private nextUsagePoll = 0;
  private usageRetryAt = 0;
  private usageLoggedReason: string | undefined;
  private readonly failureSeen = new Set<string>();
  private launchEnv: Record<string, string | undefined> = {};
  private launchProvider: Provider | undefined;
  private launchArgs: string[] = [];
  // Shared-daemon Codex only: the client process and its recent Enter presses.
  private codexRun: { pid: number; startedAt: number } | undefined;
  private codexEnters: number[] = [];
  private rolloutView = false;
  private readonly idle = new IdleClock();
  private idleShown = false;
  private remoteQueue: Promise<void> = Promise.resolve();
  owner: Peer | undefined;
  private disposed = false;

  private constructor(host: SessionHost, info: SessionInfo, child?: pty.IPty, stream?: TerminalStream) {
    this.host = host;
    this.sessionId = info.sessionId;
    this.instanceId = info.instanceId;
    this.info = info;
    this.child = child;
    this.stream = stream;
    this.resolveEnded = () => {};
    this.ended = new Promise<void>(resolve => { this.resolveEnded = resolve; });
    if (!child) this.resolveEnded();
  }

  // Restored from the registry: the PTY is gone and the context is metadata only.
  static restore(host: SessionHost, entry: RegistryEntry): SessionContext {
    const info: SessionInfo = { ...entry.session, alive: false, agent: null, usage: undefined, usageError: undefined,
      hooks: { configured: false, verified: false }, history: { records: [], readSeq: 0, unread: 0 } };
    const context = new SessionContext(host, info);
    context.selectedHistory = entry.selectedHistory;
    context.refreshHistory();
    return context;
  }

  static async spawn(host: SessionHost, options: CreateOptions): Promise<SessionContext> {
    if (!options || typeof options.command !== 'string' || !options.command || options.command.includes('\0')
      || !Array.isArray(options.args) || !options.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))
      || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd) || !validSize(options.cols, options.rows)) {
      throw new Error('invalid create options');
    }
    if (!(await lstat(options.cwd)).isDirectory()) throw new Error('working directory does not exist');
    const identity: Identity = { sessionId: randomUUID(), instanceId: randomUUID() };
    const childEnv: Record<string, string | undefined> = { ...process.env, ...options.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Tarmac',
      TARMAC_SOCKET: host.socketPath, TARMAC_SESSION_ID: identity.sessionId,
      TARMAC_INSTANCE_ID: identity.instanceId, TARMAC_HOOK_FAILURE_DIR: path.join(host.dataDir, 'hook-failures'),
      ...(host.token ? { TARMAC_TOKEN: host.token } : {}) };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.TERM_PROGRAM_VERSION;
    if (!Object.hasOwn(options.env ?? {}, 'NO_COLOR')) delete childEnv.NO_COLOR;
    const inspection = options.provider ? await inspectHookConfig(options.provider, {
      env: childEnv, homeDir: os.homedir(), cwd: options.cwd, args: options.args,
    }) : undefined;
    const child = pty.spawn(options.command, options.args, {
      cwd: options.cwd, cols: options.cols, rows: options.rows, name: 'xterm-256color', encoding: null,
      env: childEnv,
    });
    const info: SessionInfo = { ...identity, pid: child.pid, command: options.command, args: options.args,
      cwd: options.cwd, cols: options.cols, rows: options.rows, alive: true, agent: null,
      hooks: { configured: inspection?.configured ?? false, verified: false,
        source: inspection?.source, configError: inspection?.error },
      history: { records: [], readSeq: 0, unread: 0, error: host.history.lastError },
      ...(options.origin ? { origin: options.origin } : {}) };
    const context = new SessionContext(host, info, child);
    context.launchEnv = childEnv;
    context.launchProvider = options.provider;
    context.launchArgs = options.args;
    const stream = new TerminalStream(identity, options.cols, options.rows, {
      limits: host.replayLimits,
      appended: () => { if (context.stream === stream) host.pump(context); },
      changed: () => {
        if (context.stream !== stream || context.info.instanceId !== identity.instanceId) return;
        context.info.replay = stream.replay;
        host.broadcast(context);
      },
      reply: data => { if (context.info.alive) child.write(data); },
      flow: paused => { if (paused) child.pause(); else child.resume(); },
    });
    context.stream = stream;
    context.info.replay = stream.replay;
    const dataListener = child.onData(data => {
      void stream.write(Buffer.isBuffer(data) ? data : Buffer.from(data)).catch(error => {
        if (context.info.instanceId === identity.instanceId) {
          context.info.error = error instanceof Error ? error.message : 'terminal parse failed';
          host.broadcast(context);
          child.kill();
        }
      });
    });
    const exitListener = child.onExit(({ exitCode }) => {
      if (context.info.instanceId !== identity.instanceId) { context.resolveEnded(); return; }
      context.info.alive = false;
      context.info.exitCode = exitCode;
      context.info.usage = undefined;
      context.info.usageError = undefined;
      context.usageReader = undefined;
      context.usageConversation = undefined;
      context.hookTranscript = undefined;
      context.hookUsage.reset();
      context.statusLimits = undefined;
      context.leaveCodexRollout();
      if (stream.pendingBytes) context.info.error = 'process exited with an incomplete terminal sequence';
      context.state.exit();
      context.info.agent = context.state.view;
      context.state.reset();
      context.launchEnv = {};
      context.launchArgs = [];
      context.launchProvider = undefined;
      context.failureSeen.clear();
      context.child = undefined;
      void host.uploads.clearSession(context.sessionId).catch(() => {});
      void stream.idle()
        .then(() => host.persist())
        .then(() => host.broadcast(context))
        .catch(error => { context.info.error = error instanceof Error ? error.message : 'exit persistence failed'; })
        .finally(() => {
          stream.dispose();
          context.stream = undefined;
          dataListener.dispose();
          exitListener.dispose();
          host.releaseControl(context.sessionId);
          context.resolveEnded();
        });
    });
    return context;
  }

  private host: SessionHost;

  get alive(): boolean { return this.info.alive; }

  get conversation(): { provider: Provider; id: string } | undefined {
    return this.info.agent ? { provider: this.info.agent.provider, id: this.info.agent.agentSessionId } : this.usageConversation;
  }

  hideConflictingUsage(): void {
    const changed = this.info.usage !== undefined;
    this.info.usage = undefined;
    this.info.usageError = '同一 agent 会话正在多个终端运行，暂不显示无法拆分的用量';
    if (changed) this.host.broadcast(this);
  }

  view(): SessionInfo {
    const view = structuredClone(this.info);
    view.agent = this.idle.present(view.agent, Date.now());
    this.idleShown = view.agent?.activity === 'idle';
    return view;
  }

  // Idleness comes from elapsed time alone, so the periodic probe announces it when it begins.
  private announceIdle(): void {
    if (this.disposed) return;
    const idle = this.idle.present(this.info.agent, Date.now())?.activity === 'idle';
    if (idle !== this.idleShown) this.host.broadcast(this);
  }

  registryEntry(): RegistryEntry {
    return {
      session: { ...this.info, history: { records: [], readSeq: 0, unread: 0 } },
      selectedHistory: this.selectedHistory,
    };
  }

  match(identity: Identity): void {
    if (identity.sessionId !== this.sessionId || identity.instanceId !== this.instanceId) {
      throw new Error('stale session instance');
    }
  }

  private control(peer: Peer, identity: Identity): void {
    this.match(identity);
    const sub = peer.subs.get(this.sessionId);
    if (this.owner !== peer || !sub?.attached || !sub.ready) throw new Error('terminal is not ready for input');
    if (!this.info.alive || !this.child) throw new Error('process has exited');
  }

  // ifFree leaves a session another live connection controls where it is (SESSION_BUSY), so a
  // window loading sessions in the background does not take them from the window using them.
  async attach(peer: Peer, ifFree = false): Promise<SessionInfo> {
    if (!this.stream) throw new Error('process ended with daemon; only persisted input records are available');
    // A connection of the same App instance is its own earlier one (a remote link that has not timed out yet).
    if (ifFree && this.owner && this.owner !== peer && !this.owner.socket.destroyed
      && !(peer.appId && this.owner.appId === peer.appId)) throw new Error(SESSION_BUSY);
    const stream = this.stream;
    await stream.snapshot(snapshot => {
      if (this.disposed || this.stream !== stream) throw new Error('stale terminal stream');
      if (this.owner && this.owner !== peer) {
        const previous = this.owner.subs.get(this.sessionId);
        if (previous) { previous.attached = false; previous.ready = false; }
        this.host.send(this.owner, { v: VERSION, type: 'resync', sessionId: this.sessionId, instanceId: this.instanceId, reason: 'control transferred to another connection' });
      }
      this.owner = peer;
      const sub = subFor(peer, this.sessionId);
      sub.attached = true;
      sub.ready = false;
      sub.bytes = 0;
      sub.pending = [];
      sub.lastAck = -1;
      sub.lastSent = snapshot.seq;
      sub.target = snapshot.target;
      sub.snapshot = undefined;
      // A compacted base can exceed one frame (a colorful 2000-line scrollback serializes to
      // several MiB); sent whole it would fail encoding and close the connection on every attach.
      if (snapshot.data.length > SNAPSHOT_PART_CHARS) {
        const total = Math.ceil(snapshot.data.length / SNAPSHOT_PART_CHARS);
        const first = snapshot.data.slice(0, SNAPSHOT_PART_CHARS);
        sub.snapshot = { data: snapshot.data, total, sent: 1, acked: 0 };
        sub.bytes = base64Bytes(first);
        this.host.send(peer, { ...snapshot, data: first, parts: total });
      } else this.host.send(peer, snapshot);
      this.host.pump(this);
    });
    return this.view();
  }

  detach(peer: Peer): void {
    peer.subs.delete(this.sessionId);
    if (this.owner === peer) this.owner = undefined;
  }

  ack(peer: Peer, identity: Identity, seq: number, part?: number): void {
    this.match(identity);
    const sub = peer.subs.get(this.sessionId);
    if (this.owner !== peer || !sub?.attached) {
      throw new Error('not controlling connection');
    }
    if (part !== undefined) {
      const pending = sub.snapshot;
      if (!pending || !Number.isSafeInteger(part) || part !== pending.acked || part >= pending.sent || seq !== sub.lastSent) {
        throw new Error('invalid snapshot acknowledgement');
      }
      sub.bytes -= base64Bytes(pending.data.slice(part * SNAPSHOT_PART_CHARS, (part + 1) * SNAPSHOT_PART_CHARS));
      if (++pending.acked === pending.total) {
        sub.snapshot = undefined;
        sub.lastAck = seq;
        sub.ready = seq >= sub.target;
      }
      this.host.pump(this);
      return;
    }
    if (sub.snapshot) throw new Error('invalid output acknowledgement');
    if (!Number.isSafeInteger(seq) || seq < sub.lastAck || seq > sub.lastSent) throw new Error('invalid output acknowledgement');
    sub.lastAck = seq;
    sub.ready = seq >= sub.target;
    while (sub.pending[0] && sub.pending[0].seq <= seq) sub.bytes -= sub.pending.shift()!.bytes;
    this.host.pump(this);
  }

  input(peer: Peer, identity: Identity, data: string, binary?: boolean): void {
    this.control(peer, identity);
    if (typeof data !== 'string' || data.length > 1024 * 1024
      || (binary !== undefined && typeof binary !== 'boolean')) throw new Error('invalid input');
    this.child!.write(Buffer.from(data, binary ? 'base64' : 'utf8'));
    if (!binary && data.includes('\r')) this.noteEnter();
  }

  // An Enter is submit evidence for a shared-daemon Codex rollout, whoever typed it.
  private noteEnter(): void {
    if (this.info.foreground?.provider !== 'codex') return;
    const now = Date.now();
    this.codexEnters = [...this.codexEnters.filter(at => at >= now - 15_000), now].slice(-16);
    this.nextUsagePoll = Math.min(this.nextUsagePoll, now + 500);
  }

  // ---- External control (`tarmac ctl`) -----------------------------------
  // None of these attach or touch owner/ready: the App connection keeps control and its replay.

  async remoteSummary(): Promise<RemoteSession> {
    const live = this.info.alive && this.child ? await foreground(this.info.pid, this.info.cwd) : undefined;
    return { sessionId: this.sessionId, instanceId: this.instanceId, pid: this.info.pid, alive: this.info.alive,
      cwd: this.info.cwd, origin: this.info.origin ?? null, foreground: live ?? null };
  }

  async remoteScreen(identity: Identity, lines: number, join: boolean): Promise<{ text: string; alternate: boolean }> {
    const { stream } = this.remoteTarget(identity);
    await stream.drained();
    this.remoteTarget(identity);
    return screenText(stream.terminal, lines, join);
  }

  remoteText(identity: Identity, expectPid: number, text: string): Promise<void> {
    return this.remoteWrite(identity, expectPid, (child, terminal) => {
      child.write(Buffer.from(pasteBytes(text, terminal.modes.bracketedPasteMode), 'utf8'));
    });
  }

  remoteKey(identity: Identity, expectPid: number, keys: RemoteKey[]): Promise<void> {
    return this.remoteWrite(identity, expectPid, (child, terminal) => {
      child.write(Buffer.from(keyBytes(keys, terminal.modes.applicationCursorKeysMode), 'utf8'));
      if (keys.includes('Enter')) this.noteEnter();
    });
  }

  remoteClose(identity: Identity, expectPid: number): Promise<void> {
    return this.remoteWrite(identity, expectPid, child => child.kill());
  }

  private remoteTarget(identity: Identity): { child: pty.IPty; stream: TerminalStream } {
    this.match(identity);
    if (!this.info.alive || !this.child || !this.stream) throw new Error(REMOTE_ERRORS.stale);
    return { child: this.child, stream: this.stream };
  }

  // Writes run one at a time in arrival order. The foreground is computed for this request, not
  // taken from the probe cache, and the check and the write happen in the same turn.
  private remoteWrite(identity: Identity, expectPid: number,
    write: (child: pty.IPty, terminal: TerminalStream['terminal']) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const { stream } = this.remoteTarget(identity);
      await stream.drained(); // Terminal modes must reflect all output already received.
      const found = await foreground(this.info.pid, this.info.cwd);
      const target = this.remoteTarget(identity);
      if (target.stream !== stream) throw new Error(REMOTE_ERRORS.stale);
      if (found?.pid !== expectPid) throw new Error(REMOTE_ERRORS.rejected);
      write(target.child, stream.terminal);
    };
    const next = this.remoteQueue.then(run);
    this.remoteQueue = next.catch(() => {});
    return next;
  }

  async resize(peer: Peer, identity: Identity, cols: number, rows: number): Promise<void> {
    this.control(peer, identity);
    if (!validSize(cols, rows)) throw new Error('invalid terminal size');
    const child = this.child!;
    const stream = this.stream!;
    await stream.resize(cols, rows, () => {
      this.control(peer, identity);
      if (this.child !== child || this.stream !== stream) throw new Error('stale terminal stream');
      child.resize(cols, rows);
    });
    this.info.cols = cols;
    this.info.rows = rows;
    await this.host.persist();
    this.host.broadcast(this);
  }

  async close(peer: Peer, identity: Identity): Promise<void> {
    this.match(identity);
    if (!this.child) return;
    this.child.kill();
  }

  async read(peer: Peer, identity: Identity, seq: number): Promise<void> {
    this.match(identity);
    if (!this.selectedHistory) return;
    try {
      await this.host.history.markRead(this.selectedHistory.provider, this.selectedHistory.id, seq, this.selectedHistory.tarmacSessionId);
    } catch (error) {
      this.refreshHistory();
      this.host.broadcast(this);
      throw error;
    }
    this.refreshHistory();
    this.host.broadcast(this);
  }

  // Sends replay log records after the owner's cursor until its unacknowledged
  // budget is used; acknowledgements resume it. A slow owner only falls behind.
  pump(peer: Peer): void {
    const sub = peer.subs.get(this.sessionId);
    const stream = this.stream;
    if (this.owner !== peer || !sub?.attached || !stream) return;
    const pending = sub.snapshot;
    if (pending) {
      // Base parts share the unacknowledged budget with output records.
      while (pending.sent < pending.total && sub.bytes < LIMITS.subscriberBytes && !peer.socket.destroyed) {
        const data = pending.data.slice(pending.sent * SNAPSHOT_PART_CHARS, (pending.sent + 1) * SNAPSHOT_PART_CHARS);
        sub.bytes += base64Bytes(data);
        this.host.send(peer, { v: VERSION, type: 'snapshot-part', sessionId: this.sessionId, instanceId: this.instanceId, seq: sub.lastSent, part: pending.sent, data });
        pending.sent++;
      }
      return;
    }
    while (sub.bytes < LIMITS.subscriberBytes && sub.pending.length < 4096 && !peer.socket.destroyed) {
      const frames = stream.read(sub.lastSent, LIMITS.subscriberBytes - sub.bytes, 4096 - sub.pending.length);
      if (!frames) {
        this.host.send(peer, { v: VERSION, type: 'resync', sessionId: this.sessionId, instanceId: this.instanceId, reason: 'replay log was compacted past this connection' });
        sub.attached = false;
        sub.ready = false;
        if (this.owner === peer) this.owner = undefined;
        return;
      }
      if (!frames.length) return;
      for (const { event, bytes } of frames) {
        sub.bytes += bytes;
        sub.pending.push({ seq: event.seq, bytes });
        sub.lastSent = event.seq;
        this.host.send(peer, event);
      }
    }
  }

  async receiveHook(event: HookEnvelope): Promise<{ duplicate: boolean }> {
    if (!event || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)
      || !isHookProvider(event.provider)) throw new Error('invalid hook event');
    if (Buffer.byteLength(JSON.stringify(event.payload)) > LIMITS.hookBytes) throw new Error('hook payload exceeds limit');
    this.match(event);
    if (!this.info.alive) throw new Error('agent is no longer running');
    const sameInstance = (): boolean => this.info.alive && this.info.instanceId === event.instanceId;
    await this.probe();
    if (!sameInstance()) throw new Error('stale session instance');
    const current = this.info.foreground;
    if (event.agentPid === undefined && Number.isSafeInteger(event.hookPid) && event.hookPid! > 0) {
      const agentPid = await hookAgent(event.hookPid!, event.provider);
      if (agentPid) event.agentPid = agentPid;
    }
    if (!this.probeKnown || !current?.provider || current.provider !== event.provider
      || (event.agentPid !== undefined && event.agentPid !== current.pid)) {
      throw new Error('hook does not belong to current foreground agent');
    }
    if (event.payload.hook_event_name === 'StatusLine') {
      const id = event.payload.session_id;
      const file = event.payload.transcript_path;
      if (event.provider !== 'claude' || typeof id !== 'string' || !id || typeof file !== 'string' || !path.isAbsolute(file)
        || (this.info.agent && this.info.agent.agentSessionId !== id)) throw new Error('statusLine does not match current conversation');
      if (this.hookTranscript?.agentSessionId !== id) {
        this.statusLimits = undefined;
        this.usageReader = undefined;
        this.info.usage = undefined;
      }
      const at = Number.isSafeInteger(event.hookStartedAt) && event.hookStartedAt! > 0
        && event.hookStartedAt! <= Date.now() ? event.hookStartedAt! : Date.now();
      const limits = claudeSnapshotLimits(event.payload, id, file, new Date(at).toISOString());
      if (limits && (!this.statusLimits?.limits || at >= Date.parse(this.statusLimits.limits.observedAt))) {
        this.statusLimits = { sessionId: id, file, limits };
      }
      this.hookTranscript = { provider: 'claude', agentRunId: String(current.pid), agentSessionId: id, file };
      this.usageConversation = { provider: 'claude', id };
      this.nextUsagePoll = 0;
      await this.refreshUsage();
      this.host.broadcast(this);
      return { duplicate: false }; // Status snapshots never enter the prompt journal or verify lifecycle hooks.
    }
    let accepted: { duplicate: boolean };
    try {
      accepted = await this.host.history.accept(event);
    } catch (error) {
      if (sameInstance()) { this.refreshHistory(); this.host.broadcast(this); }
      throw error;
    }
    if (!sameInstance() || this.info.foreground?.pid !== current.pid || this.info.foreground?.provider !== current.provider) {
      throw new Error('agent changed before hook confirmation');
    }
    const previousAgent = this.info.agent;
    if (!accepted.duplicate) this.state.apply(event, String(current.pid));
    this.info.agent = this.state.view;
    if (this.info.agent && !this.host.allowUsage(this, this.info.agent.provider, this.info.agent.agentSessionId)) this.hideConflictingUsage();
    if (previousAgent?.agentSessionId !== this.info.agent?.agentSessionId || previousAgent?.provider !== this.info.agent?.provider) {
      this.usageReader = undefined;
      this.usageConversation = undefined;
      this.hookTranscript = undefined;
      this.nextUsagePoll = 0;
      this.info.usage = undefined;
      this.info.usageError = undefined;
      this.hookUsage.reset();
      this.statusLimits = undefined;
    }
    if (!accepted.duplicate && !isSubagentEvent(event.payload) && this.info.agent?.provider === event.provider
      && this.info.agent.agentSessionId === event.payload.session_id && this.info.agent.agentRunId === String(current.pid)
      && typeof event.payload.transcript_path === 'string' && path.isAbsolute(event.payload.transcript_path)) {
      this.hookTranscript = { provider: event.provider, agentRunId: String(current.pid),
        agentSessionId: this.info.agent.agentSessionId, file: event.payload.transcript_path };
      this.nextUsagePoll = 0;
    }
    if (!accepted.duplicate && !isSubagentEvent(event.payload) && this.info.agent?.provider === event.provider
      && this.info.agent.agentSessionId === event.payload.session_id) {
      this.hookUsage.apply(event, String(current.pid));
      this.nextUsagePoll = 0;
    }
    this.info.hooks.verified = true;
    this.info.hooks.configured = true;
    this.info.hooks.lastSuccessAt = new Date().toISOString();
    if (this.info.agent) this.selectedHistory = { provider: this.info.agent.provider, id: this.info.agent.agentSessionId, tarmacSessionId: this.sessionId };
    this.refreshHistory();
    await this.refreshUsage();
    await this.host.persist();
    if (!sameInstance()) throw new Error('stale session instance');
    this.host.broadcast(this);
    return accepted;
  }

  probe(): Promise<void> {
    if (this.probeTimer) return this.probeTimer;
    this.probeTimer = this.doProbe().finally(() => { this.probeTimer = undefined; this.announceIdle(); });
    return this.probeTimer;
  }

  get probing(): Promise<void> | undefined { return this.probeTimer; }

  private async doProbe(): Promise<void> {
    if (this.disposed || !this.info.alive) return;
    const found = await foreground(this.info.pid, this.info.cwd);
    if (this.disposed || !this.info.alive) return;
    this.probeKnown = found !== undefined;
    if (!found) return;
    const before = JSON.stringify(this.info.foreground);
    const usageBefore = JSON.stringify([this.info.usage, this.info.usageError, this.info.agent]);
    const historyBefore = JSON.stringify([this.selectedHistory, this.info.history.records.at(-1)?.seq, this.info.history.error]);
    const previous = this.info.foreground;
    this.info.foreground = found;
    // Only the launched process itself counts: a shell exec'd into tmux, not tmux started by hand.
    this.info.shellTakeover = found.pid === this.info.pid && !found.provider && /^tmux(?::|\s|$)/.test(found.name) ? 'tmux' : undefined;
    if (found?.cwd) this.info.cwd = found.cwd;
    if (previous?.pid !== found?.pid || previous?.provider !== found?.provider) {
      this.usageReader = undefined;
      this.usageConversation = undefined;
      this.hookTranscript = undefined;
      this.nextUsagePoll = 0;
      this.info.usage = undefined;
      this.info.usageError = undefined;
      this.hookUsage.reset();
      this.statusLimits = undefined;
      this.leaveCodexRollout();
      if (isHookProvider(found.provider)) this.state.bind(this.instanceId, String(found.pid));
      else this.state.reset();
      this.info.agent = this.state.view;
      this.info.hooks.verified = false;
      this.info.hooks.lastSuccessAt = undefined;
      if (isHookProvider(found.provider)) {
        const inspection = await inspectHookConfig(found.provider, {
          env: this.launchEnv, homeDir: os.homedir(), cwd: found.cwd,
          args: this.launchProvider === found.provider ? this.launchArgs : [],
        });
        if (this.disposed || !this.info.alive) return;
        this.info.hooks.configured = inspection.configured;
        this.info.hooks.source = inspection.source;
        this.info.hooks.configError = inspection.error;
      } else {
        this.info.hooks.configured = false;
        this.info.hooks.source = undefined;
        this.info.hooks.configError = undefined;
      }
      this.selectedHistory = undefined;
      this.refreshHistory();
    }
    const dir = path.join(this.host.dataDir, 'hook-failures');
    for (const name of await readdir(dir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name) || this.failureSeen.has(name)) continue;
      const file = path.join(dir, name);
      try {
        const entry = await lstat(file);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024) { this.failureSeen.add(name); continue; }
        const failure = JSON.parse(await readFile(file, 'utf8'));
        // A complete marker never changes owner, so every one (other sessions' too) is read once.
        this.failureSeen.add(name);
        if (failure.instanceId === this.instanceId && failure.sessionId === this.sessionId) {
          this.info.hooks.error = `已知输入采集缺失：${String(failure.reason).slice(0, 40)}`;
        }
      } catch { /* An incomplete or vanished marker is retried on the next probe. */ }
    }
    await this.refreshUsage();
    if (this.disposed || !this.info.alive) return;
    if (before !== JSON.stringify(found) || usageBefore !== JSON.stringify([this.info.usage, this.info.usageError, this.info.agent])
      || historyBefore !== JSON.stringify([this.selectedHistory, this.info.history.records.at(-1)?.seq, this.info.history.error])
      || this.info.hooks.error) {
      await this.host.persist();
      this.host.broadcast(this);
    }
  }

  private async refreshUsage(): Promise<void> {
    const current = this.info.foreground;
    if (!current || !isHookProvider(current.provider) || Date.now() < this.nextUsagePoll) return;
    this.nextUsagePoll = Date.now() + (current.provider === 'claude' ? 2000 : 1000);
    const provider = current.provider;
    const agentRunId = String(current.pid);
    let expectedId = this.info.agent?.agentSessionId ?? this.hookTranscript?.agentSessionId;
    const source = this.hookTranscript;
    let file = source?.provider === provider && source.agentRunId === agentRunId && source.agentSessionId === expectedId
      ? source.file : await openTranscript(current.pid, provider);
    if (provider === 'kimi') file = expectedId ? await kimiTranscript(expectedId, this.launchEnv, os.homedir(), current.cwd) : undefined;
    if (!file && provider === 'claude') {
      const discovered = await claudeTranscript(current, this.launchEnv, os.homedir());
      if (discovered && (!expectedId || expectedId === discovered.sessionId)) {
        file = discovered.file;
        expectedId = discovered.sessionId;
      }
    }
    // Shared app-server: no hook and no open rollout from this client process.
    if (provider === 'codex' && !file && !this.info.hooks.verified) {
      const bound = await this.codexRollout(current);
      if (bound) { file = bound.file.file; expectedId = bound.file.id; }
    } else this.leaveCodexRollout();
    if (this.disposed || !this.info.alive || this.info.foreground !== current) return;
    if (!file) {
      this.usageReader = undefined;
      const observed = this.hookUsage.view;
      if (observed && !this.host.allowUsage(this, observed.provider, observed.agentSessionId)) {
        this.hideConflictingUsage();
        return;
      }
      this.info.usage = this.withKimiQuota(observed, current.cwd);
      this.info.usageError = undefined;
      return;
    }
    // A failed reader is sticky; after the retry delay it is rebuilt and reads from the start.
    if (this.usageReader?.file !== file || this.usageReader.provider !== provider
      || this.usageReader.agentRunId !== agentRunId || this.usageReader.expectedSessionId !== expectedId
      || (this.usageRetryAt > 0 && Date.now() >= this.usageRetryAt)) {
      this.usageReader = new UsageReader(provider, agentRunId, file, expectedId);
      this.usageRetryAt = 0;
    }
    const reader = this.usageReader;
    try {
      const usage = await reader.read() ?? this.hookUsage.view;
      if (usage?.provider === 'claude') {
        const cache = await claudeRateLimits(usage.agentSessionId, file, this.launchEnv, os.homedir());
        const snapshot = this.statusLimits?.sessionId === usage.agentSessionId && this.statusLimits.file === file
          ? this.statusLimits.limits : undefined;
        const limits = snapshot && (!cache || Date.parse(snapshot.observedAt) >= Date.parse(cache.observedAt)) ? snapshot : cache;
        const previous = this.info.usage?.agentSessionId === usage.agentSessionId && this.info.usage.agentRunId === agentRunId
          ? this.info.usage.rateLimits : undefined;
        usage.rateLimits = limits && (!previous || Date.parse(limits.observedAt) >= Date.parse(previous.observedAt)) ? limits : previous;
        const account = claudeAccountOf(file);
        if (account && limits) this.host.claudeQuota.offer(account, limits);
        const shared = account ? this.host.claudeQuota.get(account) : undefined;
        if (shared && (!usage.rateLimits || Date.parse(shared.observedAt) > Date.parse(usage.rateLimits.observedAt))) {
          usage.rateLimits = { ...shared, source: 'shared' };
        }
      }
      if (this.disposed || this.usageReader !== reader || !this.info.alive) return;
      const kimiTurn = provider === 'kimi' ? this.state.openKimiTurn : undefined;
      const ended = kimiTurn === undefined ? undefined : reader.kimiTurnEnd(kimiTurn);
      if (ended && expectedId && this.state.kimiTurnEnded(expectedId, agentRunId, kimiTurn!, ended.reason, ended.time)) {
        this.info.agent = this.state.view;
      }
      this.usageConversation = usage ? { provider: usage.provider, id: usage.agentSessionId } : undefined;
      if (usage && !this.host.allowUsage(this, usage.provider, usage.agentSessionId)) {
        this.hideConflictingUsage();
        return;
      }
      this.info.usage = this.withKimiQuota(usage, current.cwd);
      this.info.usageError = undefined;
      this.usageLoggedReason = undefined;
    } catch (error) {
      if (this.usageReader !== reader || !this.info.alive) return;
      const reason = usageFailureReason(error);
      this.info.usage = undefined;
      this.info.usageError = `暂时无法读取当前会话用量：${reason}`;
      this.usageRetryAt = Date.now() + USAGE_RETRY_MS;
      if (reason !== this.usageLoggedReason) {
        this.usageLoggedReason = reason;
        this.host.log(`usage read failed (${provider}) session ${this.sessionId}: ${reason}`);
      }
    }
  }

  // Kimi's plan quota belongs to the account, not the conversation; it rides on that session's usage.
  private withKimiQuota(usage: TokenUsage | undefined, cwd: string): TokenUsage | undefined {
    if (usage?.provider !== 'kimi') return usage;
    const home = kimiHome(this.launchEnv, os.homedir(), cwd);
    this.host.kimiQuota.poll(home);
    const limits = this.host.kimiQuota.limits(home);
    return limits ? { ...usage, rateLimits: limits } : usage;
  }

  private async codexRollout(current: NonNullable<SessionInfo['foreground']>):
    Promise<{ binding: RolloutBinding; file: RolloutFile } | undefined> {
    if (this.codexRun?.pid !== current.pid) {
      const startedAt = await processStartedAt(current.pid);
      if (startedAt === undefined || this.info.foreground !== current) { this.leaveCodexRollout(); return; }
      this.codexRun = { pid: current.pid, startedAt };
    }
    const configured = this.launchEnv.CODEX_HOME;
    const home = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.codex');
    this.host.codexRollouts.report({ key: this.instanceId, home, pid: current.pid, cwd: current.cwd,
      startedAt: this.codexRun.startedAt, enters: [...this.codexEnters] });
    const resolved = await this.host.codexRollouts.resolve(this.instanceId);
    if (this.disposed || !this.info.alive || this.info.foreground !== current || this.info.hooks.verified) return;
    if (!resolved) {
      if (this.rolloutView) { this.info.agent = this.state.view; this.rolloutView = false; }
      return;
    }
    const activity = rolloutActivity(resolved.file, resolved.binding.from);
    // Rollouts carry no approval events; the authoritative headless screen does.
    const approval = activity.activity === 'working' && codexApprovalOnScreen(this.screenLines());
    this.info.agent = { provider: 'codex', agentSessionId: resolved.file.id, agentRunId: String(current.pid),
      ...activity, ...(approval ? { activity: 'permission' as const, reason: 'screen_approval_prompt' } : {}), pendingTools: [] };
    this.rolloutView = true;
    await this.recordRolloutPrompts(resolved, current);
    return resolved;
  }

  // Shared app-server sends no UserPromptSubmit; the bound rollout's own user messages stand in.
  private async recordRolloutPrompts(resolved: { binding: RolloutBinding; file: RolloutFile },
    current: NonNullable<SessionInfo['foreground']>): Promise<void> {
    const { binding, file } = resolved;
    let changed = this.selectedHistory?.provider !== 'codex' || this.selectedHistory.id !== file.id
      || this.selectedHistory.tarmacSessionId !== this.sessionId;
    this.selectedHistory = { provider: 'codex', id: file.id, tarmacSessionId: this.sessionId };
    for (const prompt of file.prompts) {
      const eventId = `codex-rollout:${prompt.id}`;
      if (prompt.at < binding.from || this.host.history.hasEvent(eventId)) continue;
      try {
        const accepted = await this.host.history.acceptPrompt({ eventId, provider: 'codex', agentSessionId: file.id,
          at: new Date(prompt.at).toISOString(), prompt: prompt.text, tarmacSessionId: this.sessionId });
        if (!accepted.duplicate) changed = true;
      } catch { changed = true; break; } // The store error is shown with the history view.
      if (this.disposed || !this.info.alive || this.info.foreground !== current) return;
    }
    if (changed) this.refreshHistory();
  }

  private leaveCodexRollout(): void {
    if (this.codexRun || this.rolloutView) this.host.codexRollouts.remove(this.instanceId);
    this.codexRun = undefined;
    if (this.rolloutView) { this.info.agent = this.state.view; this.rolloutView = false; }
  }

  private screenLines(): string[] {
    const terminal = this.stream?.terminal;
    if (!terminal) return [];
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + terminal.rows; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return lines;
  }

  private refreshHistory(): void {
    this.info.history = this.selectedHistory
      ? this.host.history.view(this.selectedHistory.provider, this.selectedHistory.id, this.selectedHistory.tarmacSessionId)
      : { records: [], readSeq: 0, unread: 0, error: this.host.history.lastError };
    const full = this.info.history;
    let budget = 512 * 1024;
    const visible = [];
    let preview = false;
    for (let index = full.records.length - 1; index >= 0; index--) {
      const record = full.records[index];
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (bytes <= budget) { visible.unshift(record); budget -= bytes; continue; }
      if (!visible.length) {
        visible.unshift({ ...record, prompt: record.prompt.slice(0, 60_000) });
        preview = true;
      }
      break;
    }
    if (visible.length !== full.records.length || preview) {
      full.displayNote = `显示最近 ${visible.length}／${full.records.length} 条${preview ? '，超长输入仅显示预览' : ''}；完整记录保存在本机。`;
    }
    full.records = visible;
  }

  // Daemon shutdown support.
  kill(): void {
    try { this.child?.kill(); } catch { /* already gone */ }
  }

  async forceKillAfter(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child) return;
    // node-pty on Windows rejects signals; end the remaining process tree instead.
    const timer = setTimeout(() => { try { if (process.platform === 'win32') killTree(child.pid); else child.kill('SIGKILL'); } catch {} }, timeoutMs);
    try { await this.ended; } finally { clearTimeout(timer); }
  }

  async teardown(): Promise<void> {
    this.disposed = true;
    await this.probeTimer;
    const stream = this.stream;
    if (stream) {
      await stream.idle();
      stream.dispose();
      this.stream = undefined;
    }
    this.host.releaseControl(this.sessionId);
  }
}
