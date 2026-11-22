import net from 'node:net';
import path from 'node:path';
import { mkdir, chmod, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { VERSION, LIMITS, REMOTE_ERRORS, REMOTE_KEYS, REMOTE_ORIGIN, REMOTE_SCREEN_LINES, REMOTE_TEXT_BYTES, encodeFrame } from '../../protocol/src/index.ts';
import { endpointPath, newToken, ownedByCurrentUser, sameToken, tokenRequired, writeToken } from '../../protocol/src/platform.ts';
import type { CreateOptions, RequestFrame, ServerFrame, SessionInfo, HookEnvelope, Provider, Identity } from '../../protocol/src/index.ts';
import { HistoryStore } from './history.ts';
import { claimRuntime } from './runtime.ts';
import type { Lease } from './lease.ts';
import { SessionContext } from './session.ts';
import { createPeer, detachPeer } from './peer.ts';
import type { Peer } from './peer.ts';
import { CodexRolloutTracker } from './codex-rollout.ts';
import { KimiQuota } from './kimi-quota.ts';
import { ClaudeAccountQuota } from './claude-usage.ts';
import { stopHelper } from './winproc.ts';
import { daemonLog } from './log.ts';
import type { ReplayLimits } from './terminal.ts';
import { inspectDirectories } from './workspace.ts';
import { sampleSystem } from './system.ts';
import { UploadStore } from './uploads.ts';

// A write target must name the agent process the caller verified itself.
function remoteWrite<T extends Identity & { expectPid: unknown }>(request: T): T {
  if (!Number.isSafeInteger(request.expectPid) || (request.expectPid as number) <= 1) throw new Error(REMOTE_ERRORS.invalid);
  return request;
}

export interface DaemonOptions {
  // Defaults to tokenRequired(); tests enable it on POSIX to cover the handshake.
  requireToken?: boolean;
  replayLimits?: Partial<ReplayLimits>;
  // Tests replace the network request behind the Kimi quota.
  kimiQuota?: KimiQuota;
}

interface RegistryEntry {
  session: SessionInfo;
  selectedHistory?: { provider: Provider; id: string; tarmacSessionId?: string };
}

export class Daemon {
  readonly dataDir: string;
  readonly socketPath: string;
  readonly token: string | undefined;
  readonly replayLimits: Partial<ReplayLimits> | undefined;
  readonly log: (message: string) => void;
  private server: net.Server;
  private peers = new Set<Peer>();
  private contexts = new Map<string, SessionContext>();
  readonly history: HistoryStore;
  readonly codexRollouts = new CodexRolloutTracker();
  readonly kimiQuota: KimiQuota;
  readonly claudeQuota = new ClaudeAccountQuota();
  readonly uploads: UploadStore;
  private pollTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private shutdownRequested = false;
  private stopTask: Promise<void> | undefined;
  private opening: Promise<void> | undefined;
  private creates = new Set<Promise<SessionInfo>>();
  private listening = false;
  private ready = false;
  private lease: Lease | undefined;
  private registryQueue: Promise<void> = Promise.resolve();
  private registryTask: Promise<void> | undefined;
  private registryRevision = 0;

  constructor(dataDir: string, options: DaemonOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.socketPath = endpointPath(this.dataDir);
    this.token = (options.requireToken ?? tokenRequired()) ? newToken() : undefined;
    this.replayLimits = options.replayLimits;
    this.kimiQuota = options.kimiQuota ?? new KimiQuota();
    this.log = daemonLog(this.dataDir);
    this.history = new HistoryStore(this.dataDir);
    this.uploads = new UploadStore(path.join(this.dataDir, 'uploads'));
    this.server = net.createServer(socket => this.connect(socket));
  }

  async start(): Promise<void> {
    if (this.ready || this.listening || this.lease) throw new Error('daemon is already started');
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !ownedByCurrentUser(directory)) throw new Error('data directory must be an owned directory');
    await chmod(this.dataDir, 0o700);
    await mkdir(path.join(this.dataDir, 'hook-failures'), { recursive: true, mode: 0o700 });
    // On Windows the pipe itself is the lease: libuv binds it with FILE_FLAG_FIRST_PIPE_INSTANCE,
    // so a second daemon gets EADDRINUSE, and the pipe vanishes with its process. The journal
    // and registry are loaded only after the bind succeeded.
    const pipe = process.platform === 'win32';
    if (!pipe) this.lease = await claimRuntime(this.dataDir, this.socketPath);
    this.opening = this.open(pipe);
    try { await this.opening; } catch (error) { await this.stop(); throw error; }
  }

  // The socket accepts connections before loading finishes; stop() waits for this to settle so
  // nothing created here (restored sessions, the probe timer) outlives the daemon.
  private async open(pipe: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) => reject(pipe && error.code === 'EADDRINUSE'
        ? new Error('another live daemon owns this data directory') : error);
      this.server.once('error', failed);
      this.server.listen(this.socketPath, () => { this.server.removeListener('error', failed); resolve(); });
    });
    this.listening = true;
    if (!pipe) await chmod(this.socketPath, 0o600);
    // Written only while holding the endpoint, so a live daemon's token is never replaced.
    if (this.token) await writeToken(this.dataDir, this.token);
    // Corrupt history must remain visible without taking away the real terminals.
    await this.history.initialize().catch(() => {});
    // No process outlives the daemon, so no pasted image is still needed.
    await this.uploads.clearAll().catch(() => {});
    await this.loadRegistry();
    this.pollTimer = setInterval(() => { void this.probeAll().catch(() => {}); }, 500);
    this.ready = true;
  }

  private async loadRegistry(): Promise<void> {
    let saved: any;
    try {
      saved = JSON.parse(await readFile(path.join(this.dataDir, 'registry.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Corrupt or unreadable registries are never overwritten silently.
      throw new Error(`registry.json 无法读取，已保留原文件：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!saved || typeof saved !== 'object') throw new Error('registry.json 结构不兼容，已保留原文件');
    if (saved.v === 2 || saved.v === VERSION) {
      if (!Array.isArray(saved.sessions)) throw new Error('registry.json 缺少 sessions 数组，已保留原文件');
      for (const entry of saved.sessions as RegistryEntry[]) {
        if (!entry?.session || typeof entry.session.sessionId !== 'string' || typeof entry.session.instanceId !== 'string') {
          throw new Error('registry.json 会话条目无效，已保留原文件');
        }
        const context = SessionContext.restore(this, entry);
        this.contexts.set(context.sessionId, context);
      }
      return;
    }
    if (saved.v === 1) {
      // Read migration: the old single-session registry becomes one ended
      // session. Its process is never assumed alive.
      if (saved.session === null) { await this.persist(); return; }
      if (!saved.session || typeof saved.session.sessionId !== 'string' || typeof saved.session.instanceId !== 'string') throw new Error('registry.json v1 缺少 session，已保留原文件');
      const context = SessionContext.restore(this, { session: saved.session as SessionInfo, selectedHistory: saved.selectedHistory });
      this.contexts.set(context.sessionId, context);
      await this.persist();
      return;
    }
    throw new Error(`registry.json 版本 ${String(saved.v)} 不受支持，已保留原文件`);
  }

  list(): SessionInfo[] {
    return [...this.contexts.values()].map(context => context.view());
  }

  private connect(socket: net.Socket): void {
    const peer = createPeer(socket, !this.token);
    this.peers.add(peer);
    let buffer = '';
    let inFlight = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMITS.frameBytes && !buffer.includes('\n')) { this.log('closed connection: request exceeds frame limit'); return socket.destroy(); }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > LIMITS.frameBytes || ++inFlight > 32) {
          this.log(`closed connection: ${inFlight > 32 ? 'more than 32 requests in flight' : 'request exceeds frame limit'}`);
          return socket.destroy();
        }
        let request: RequestFrame;
        try {
          request = JSON.parse(line) as RequestFrame;
          if (!request || typeof request !== 'object' || typeof request.id !== 'string' || request.id.length > 128) throw new Error('invalid request');
        } catch { this.log('closed connection: invalid request'); socket.destroy(); return; }
        if (!peer.authenticated && request.type !== 'auth') { this.log('closed connection: request before authentication'); socket.destroy(); return; }
        void this.handle(peer, request).then(value => {
          this.send(peer, { v: VERSION, type: 'result', id: request.id, ok: true, value });
        }, error => {
          // Only the reason is logged: a rejected hook leaves no other trace of why it failed.
          if (request.type === 'hook') this.log(`hook rejected (${String(request.event?.provider).slice(0, 16)}): ${error instanceof Error ? error.message : 'request failed'}`);
          this.send(peer, { v: VERSION, type: 'result', id: request.id, ok: false, error: error instanceof Error ? error.message : 'request failed' });
        }).finally(() => { inFlight--; });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.peers.delete(peer);
      for (const context of this.contexts.values()) {
        if (context.owner === peer) context.owner = undefined;
        detachPeer(peer, context.sessionId);
      }
    });
  }

  private contextOf(identity: Identity): SessionContext {
    const context = this.contexts.get(identity.sessionId);
    if (!context) throw new Error('stale session instance');
    context.match(identity);
    return context;
  }

  private async handle(peer: Peer, request: RequestFrame): Promise<unknown> {
    if (request.v !== VERSION) throw new Error('protocol version mismatch');
    // Synchronous before any await: frames that follow in the same chunk see the result.
    if (request.type === 'auth') {
      if (!this.token) return null;
      if (!sameToken(this.token, request.token)) { setImmediate(() => peer.socket.destroy()); throw new Error('authentication failed'); }
      peer.authenticated = true;
      return null;
    }
    if (this.closing || this.shutdownRequested) throw new Error('daemon shutting down');
    if (!this.ready) throw new Error('daemon initializing');
    switch (request.type) {
      case 'list': return this.list();
      case 'desktop-register':
        peer.desktop = true;
        if (typeof request.appId === 'string' && request.appId.length <= 64) peer.appId = request.appId;
        return { desktops: [...this.peers].filter(other => other.desktop && !other.socket.destroyed).length };
      case 'desktop-exit': {
        if (!peer.desktop) throw new Error('desktop is not registered');
        if (request.confirmed !== undefined && typeof request.confirmed !== 'boolean') throw new Error('invalid exit confirmation');
        if ([...this.peers].some(other => other !== peer && other.desktop && !other.socket.destroyed)) {
          peer.desktop = false;
          return 'detached';
        }
        if (!request.confirmed && (this.creates.size > 0 || [...this.contexts.values()].some(context => context.alive))) {
          return 'confirmation-required';
        }
        peer.desktop = false;
        this.shutdownRequested = true;
        setImmediate(() => { void this.stop().catch(() => { process.exitCode = 1; }); });
        return 'shutdown';
      }
      case 'create': {
        const task = this.create(request.options);
        this.creates.add(task);
        try { return await task; }
        finally { this.creates.delete(task); }
      }
      case 'hook': return this.contextOf(request.event).receiveHook(request.event);
      case 'shutdown':
        this.shutdownRequested = true;
        setImmediate(() => { void this.stop().catch(() => { process.exitCode = 1; }); });
        return null;
      case 'attach': return this.contextOf(request).attach(peer, request.ifFree === true);
      case 'detach': this.contextOf(request).detach(peer); return null;
      case 'ack': this.contextOf(request).ack(peer, request, request.seq, request.part); return null;
      case 'input': this.contextOf(request).input(peer, request, request.data, request.binary); return null;
      case 'resize': await this.contextOf(request).resize(peer, request, request.cols, request.rows); return null;
      case 'close': await this.contextOf(request).close(peer, request); return null;
      case 'read': await this.contextOf(request).read(peer, request, request.seq); return null;
      case 'workspace': return inspectDirectories(request.paths);
      case 'system': return sampleSystem();
      case 'upload': {
        const context = this.contextOf(request);
        if (!context.alive) throw new Error('process has exited');
        return this.uploads.write(context.sessionId, request);
      }
      case 'remote-list': return Promise.all([...this.contexts.values()].map(context => context.remoteSummary()));
      case 'remote-screen':
        if (!Number.isSafeInteger(request.lines) || request.lines < 1 || request.lines > REMOTE_SCREEN_LINES
          || typeof request.join !== 'boolean') throw new Error(REMOTE_ERRORS.invalid);
        return this.contextOf(request).remoteScreen(request, request.lines, request.join);
      case 'remote-text':
        if (typeof request.text !== 'string' || !request.text || Buffer.byteLength(request.text) > REMOTE_TEXT_BYTES) throw new Error(REMOTE_ERRORS.invalid);
        await this.contextOf(remoteWrite(request)).remoteText(request, request.expectPid, request.text);
        return null;
      case 'remote-key':
        if (!Array.isArray(request.keys) || !request.keys.length || request.keys.length > 64
          || !request.keys.every(key => (REMOTE_KEYS as readonly unknown[]).includes(key))) throw new Error(REMOTE_ERRORS.invalid);
        await this.contextOf(remoteWrite(request)).remoteKey(request, request.expectPid, request.keys);
        return null;
      case 'remote-close': await this.contextOf(remoteWrite(request)).remoteClose(request, request.expectPid); return null;
      case 'remote-create': {
        const { cwd, command, args, origin } = request;
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof command !== 'string' || !command
          || !Array.isArray(args) || (origin !== undefined && (typeof origin !== 'string' || !REMOTE_ORIGIN.test(origin)))) {
          throw new Error(REMOTE_ERRORS.invalid);
        }
        const directory = await lstat(cwd).catch(() => undefined);
        if (!directory?.isDirectory()) throw new Error(REMOTE_ERRORS.invalid);
        // Same path as the App's create: environment, hooks and usage match an App session.
        const task = this.create({ command, args, cwd, cols: 120, rows: 40, ...(origin ? { origin } : {}) });
        this.creates.add(task);
        try {
          const session = await task;
          return { sessionId: session.sessionId, instanceId: session.instanceId, pid: session.pid };
        } catch (error) {
          throw error instanceof Error && error.message === 'invalid create options' ? new Error(REMOTE_ERRORS.invalid) : error;
        } finally { this.creates.delete(task); }
      }
      default: throw new Error('unknown request type');
    }
  }

  private async create(options: CreateOptions): Promise<SessionInfo> {
    const context = await SessionContext.spawn(this, options);
    if (this.closing || this.shutdownRequested) {
      context.kill();
      await context.forceKillAfter(1500);
      await context.teardown();
      throw new Error('daemon shutting down');
    }
    this.contexts.set(context.sessionId, context);
    await this.persist();
    this.broadcast(context);
    return context.view();
  }

  private async probeAll(): Promise<void> {
    await Promise.allSettled([...this.contexts.values()].filter(context => context.alive).map(context => context.probe()));
  }

  // ---- SessionHost -------------------------------------------------------

  persist(): Promise<void> {
    this.registryRevision++;
    if (this.registryTask) return this.registryTask;
    const task = Promise.resolve().then(async () => {
      let written = -1;
      while (written !== this.registryRevision) {
        const revision = this.registryRevision;
        const saved = JSON.stringify({ v: VERSION, sessions: [...this.contexts.values()].map(context => context.registryEntry()) }) + '\n';
        const file = path.join(this.dataDir, 'registry.tmp');
        await writeFile(file, saved, { mode: 0o600 });
        await rename(file, path.join(this.dataDir, 'registry.json'));
        written = revision;
      }
    });
    this.registryTask = task;
    const finished = (): void => { if (this.registryTask === task) this.registryTask = undefined; };
    void task.then(finished, finished);
    this.registryQueue = task.catch(() => {});
    return task;
  }

  broadcast(context: SessionContext): void {
    const frame = { v: VERSION, type: 'info', session: context.view() } satisfies ServerFrame;
    for (const peer of this.peers) this.send(peer, frame);
  }

  pump(context: SessionContext): void {
    if (context.owner) context.pump(context.owner);
  }

  allowUsage(context: SessionContext, provider: Provider, agentSessionId: string): boolean {
    const conflicts = [...this.contexts.values()].filter(other => other !== context && other.alive
      && other.conversation?.provider === provider && other.conversation.id === agentSessionId);
    for (const other of conflicts) other.hideConflictingUsage();
    return conflicts.length === 0;
  }

  send(peer: Peer, frame: ServerFrame): void {
    if (peer.socket.destroyed || (!peer.authenticated && frame.type !== 'result')) return;
    const target = 'sessionId' in frame ? ` session ${frame.sessionId}` : '';
    if (peer.socket.writableLength > LIMITS.frameBytes) {
      this.log(`closed connection: ${peer.socket.writableLength} bytes not read by the client, sending ${frame.type}${target}`);
      peer.socket.destroy();
      return;
    }
    try { peer.socket.write(encodeFrame(frame)); }
    catch (error) {
      this.log(`closed connection: cannot send ${frame.type}${target}: ${error instanceof Error ? error.message : String(error)}`);
      peer.socket.destroy();
    }
  }

  releaseControl(sessionId: string): void {
    for (const peer of this.peers) detachPeer(peer, sessionId);
    for (const context of this.contexts.values()) {
      if (context.sessionId === sessionId && context.owner) context.owner = undefined;
    }
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.closing = true;
    this.ready = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.stopTask = this.finishStop();
    return this.stopTask;
  }

  private async finishStop(): Promise<void> {
    await this.opening?.catch(() => {});
    this.ready = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await Promise.allSettled([...this.creates]);
    for (const context of this.contexts.values()) context.kill();
    await Promise.allSettled([...this.contexts.values()].map(context => context.forceKillAfter(1500)));
    await Promise.allSettled([...this.contexts.values()].map(context => context.teardown()));
    await this.registryQueue;
    for (const peer of this.peers) peer.socket.destroy();
    if (this.listening) {
      await new Promise<void>(resolve => this.server.close(() => resolve()));
      this.listening = false;
    }
    await this.lease?.release();
    this.lease = undefined;
    stopHelper();
  }
}
