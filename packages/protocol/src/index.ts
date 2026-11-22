// v3: Kimi telemetry and registered desktop lifecycle require an updated daemon.
// Older daemons must not silently accept unsupported telemetry or exit behavior.
export const VERSION = 3;
export const LIMITS = Object.freeze({
  frameBytes: 8 * 1024 * 1024,
  hookBytes: 4 * 1024 * 1024,
  subscriberBytes: 2 * 1024 * 1024,
  parseHighBytes: 1024 * 1024,
  parseLowBytes: 256 * 1024,
  scrollback: 2000,
  hookTimeoutMs: 500,
  replayCompactBytes: 8 * 1024 * 1024,
  replayRetryBytes: 4 * 1024 * 1024,
  replayMaxBytes: 32 * 1024 * 1024,
  replayFrameBytes: 256 * 1024,
});

export type Provider = 'claude' | 'codex' | 'kimi' | 'agy';
export type AgentKind = Provider;
export function isHookProvider(kind: AgentKind | undefined): kind is Provider {
  return kind === 'claude' || kind === 'codex' || kind === 'kimi' || kind === 'agy';
}
// idle is presented by the daemon for waiting that lasts without activity; trackers never set it.
export type Activity = 'running' | 'working' | 'permission' | 'waiting' | 'idle' | 'exited';
export interface HookEnvelope {
  eventId: string;
  sessionId: string;
  instanceId: string;
  provider: Provider;
  agentPid?: number;
  // Windows: the hook's own PID; the daemon resolves the agent ancestor from its process table.
  hookPid?: number;
  hookStartedAt?: number;
  payload: Record<string, unknown>;
}
export interface AgentView {
  provider: Provider;
  agentSessionId: string;
  agentRunId: string;
  activity: Activity;
  reason?: string;
  turnId?: string;
  pendingTools: string[];
}
export interface HookHealth {
  configured: boolean;
  verified: boolean;
  source?: string;
  configError?: string;
  lastSuccessAt?: string;
  error?: string;
}
export interface InputRecord {
  eventId: string;
  provider: Provider;
  agentSessionId: string;
  seq: number;
  at: string;
  prompt: string;
  tarmacSessionId?: string;
}
export interface HistoryView {
  records: InputRecord[];
  readSeq: number;
  unread: number;
  capturedSince?: string;
  error?: string;
  displayNote?: string;
}
export interface Foreground {
  pid: number;
  name: string;
  cwd: string;
  provider?: AgentKind;
  profile?: string;
}
export interface ReplayView {
  // false once a checkpoint could not be verified; restoration may then differ.
  exact: boolean;
  reason?: string;
  // First probe section that differed in the most recent failed verification.
  lastCheckFailure?: string;
}
export interface TokenUsage {
  provider: Provider;
  agentSessionId: string;
  agentRunId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  scope?: 'observed';
  rateLimits?: {
    observedAt: string;
    // 'account': fetched from the provider's account endpoint (Kimi), not recorded by the session.
    // 'shared': recorded by another session of the same account (Claude configuration directory).
    source?: 'account' | 'shared';
    // period names a window that has no fixed length, such as a calendar month (windowMinutes 0).
    windows: { windowMinutes: number; period?: string; usedPercent: number; resetsAt: number }[];
  };
}
export interface SessionInfo {
  sessionId: string;
  instanceId: string;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode?: number;
  error?: string;
  foreground?: Foreground;
  // The launched shell replaced itself with a tmux client (a startup file runs `exec tmux`).
  shellTakeover?: 'tmux';
  replay?: ReplayView;
  usage?: TokenUsage;
  usageError?: string;
  agent: AgentView | null;
  hooks: HookHealth;
  history: HistoryView;
  // Who created the session from outside the App (`tarmac ctl create --origin`); kept across restarts.
  origin?: string;
}
export interface CreateOptions {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  provider?: Provider;
  origin?: string;
}
// External control (`tarmac ctl`), contract in docs/tarmac-ctl.md. These requests never
// attach, take or change the owner, so the App connection keeps control and sees no resync.
export const REMOTE_KEYS = ['Enter', 'Up', 'Down', 'Escape'] as const;
export type RemoteKey = typeof REMOTE_KEYS[number];
export const REMOTE_TEXT_BYTES = 1024 * 1024;
export const REMOTE_SCREEN_LINES = 2000;
export const REMOTE_ORIGIN = /^[a-z0-9-]{1,32}$/;
// Error messages the CLI maps to its codes; any other failure is reported as `failed`.
export const REMOTE_ERRORS = Object.freeze({
  stale: 'stale session instance',
  rejected: 'expected process is not in the foreground',
  invalid: 'invalid remote request',
});
export interface RemoteSession {
  sessionId: string;
  instanceId: string;
  pid: number;
  alive: boolean;
  cwd: string;
  origin: string | null;
  foreground: Foreground | null;
}
// Cumulative counters of the daemon's machine (`system` request); clients derive rates from two samples.
export interface SystemSample {
  at: number;
  // Minutes east of UTC on that machine, for showing its local time; absent from earlier builds.
  utcOffset?: number;
  cores: number;
  // Milliseconds summed over all cores since boot.
  cpuIdle: number;
  cpuTotal: number;
  memTotal: number;
  memAvailable: number;
  // Bytes over physical interfaces; null where not collected (Windows).
  net: { rx: number; tx: number } | null;
}
export interface Identity { sessionId: string; instanceId: string }
// Images the App pastes into a session whose agent cannot read the App's clipboard (remote hosts):
// sent in parts (`upload`), saved on the daemon's machine, and the saved path is pasted instead.
export const UPLOAD_PART_BYTES = 1024 * 1024;
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_KINDS = ['png', 'jpg', 'gif', 'webp'] as const;
export type UploadKind = typeof UPLOAD_KINDS[number];
export const UPLOAD_ID = /^[0-9a-f]{32}$/;
// The attach failure that says another connection (another window or machine) controls the session.
export const SESSION_BUSY = 'session controlled by another connection';
export type DesktopExitResult = 'detached' | 'confirmation-required' | 'shutdown';
export type Request =
  // Required first request where tokenRequired() holds (platform.ts).
  | { type: 'auth'; token: string }
  | { type: 'list' }
  // appId: the App instance, kept across its reconnects (see attach ifFree).
  | { type: 'desktop-register'; appId?: string }
  | { type: 'desktop-exit'; confirmed?: boolean }
  | { type: 'create'; options: CreateOptions }
  // ifFree: take control only if no other connection holds it; otherwise fails with SESSION_BUSY.
  | ({ type: 'attach'; ifFree?: boolean } & Identity)
  | ({ type: 'detach' } & Identity)
  // part acknowledges one part of a split replay base (see snapshot-part).
  | ({ type: 'ack'; seq: number; part?: number } & Identity)
  | ({ type: 'input'; data: string; binary?: boolean } & Identity)
  | ({ type: 'resize'; cols: number; rows: number } & Identity)
  | ({ type: 'close' } & Identity)
  | ({ type: 'read'; seq: number } & Identity)
  | { type: 'hook'; event: HookEnvelope }
  | { type: 'shutdown' }
  | { type: 'remote-list' }
  | ({ type: 'remote-screen'; lines: number; join: boolean } & Identity)
  | ({ type: 'remote-text'; expectPid: number; text: string } & Identity)
  | ({ type: 'remote-key'; expectPid: number; keys: RemoteKey[] } & Identity)
  | ({ type: 'remote-close'; expectPid: number } & Identity)
  | { type: 'remote-create'; cwd: string; command: string; args: string[]; origin?: string }
  // Read-only: existence and git branch of directories on the daemon's machine (remote hosts).
  | { type: 'workspace'; paths: string[] }
  // Read-only: CPU, memory and network counters of the daemon's machine (App title bar).
  | { type: 'system' }
  // One part (base64) of an image for a live session; answered with null until the last part,
  // then with the saved file's absolute path. Parts arrive in order, starting at 0.
  | ({ type: 'upload'; uploadId: string; kind: UploadKind; part: number; parts: number; data: string } & Identity);
export type RequestFrame = Request & { v: number; id: string };
export type ServerEvent =
  // Replay base: seq is the base position, target the log end when attaching. A base larger than
  // one frame arrives in parts: this frame carries part 0 and the total, snapshot-part frames the
  // rest; each part is acknowledged with ack.part before output records follow.
  | ({ v: number; type: 'snapshot'; seq: number; cols: number; rows: number; data: string; target: number; exact: boolean; parts?: number } & Identity)
  | ({ v: number; type: 'snapshot-part'; seq: number; part: number; data: string } & Identity)
  // Covers consecutive output records first..seq.
  | ({ v: number; type: 'output'; first: number; seq: number; data: string } & Identity)
  | ({ v: number; type: 'resize'; seq: number; cols: number; rows: number } & Identity)
  // One session per event; clients merge by sessionId and use list for the full set.
  | { v: number; type: 'info'; session: SessionInfo }
  | ({ v: number; type: 'resync'; reason: string } & Identity);
export interface ResultFrame {
  v: number;
  type: 'result';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export type ServerFrame = ServerEvent | ResultFrame;

export function validSize(cols: unknown, rows: unknown): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows)
    && (cols as number) >= 2 && (cols as number) <= 500
    && (rows as number) >= 1 && (rows as number) <= 200;
}

// Base64 characters per replay base part: whole 3-byte groups, so each part decodes on its own.
export const SNAPSHOT_PART_CHARS = Math.ceil(LIMITS.replayFrameBytes / 3) * 4;
export const base64Bytes = (data: string): number => Math.floor(data.length * 3 / 4);

export function encodeFrame(frame: unknown): string {
  const line = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(line) > LIMITS.frameBytes) throw new Error('frame exceeds limit');
  return line;
}
