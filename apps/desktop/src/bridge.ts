import type { CreateOptions, Identity, Request, ServerEvent, SessionInfo } from '../../../packages/protocol/src/index.ts';
import type { WorkspaceView } from './projects.ts';
import type { RcPlan } from '../../../packages/cli/src/shell-rc.ts';
import type { CheckStep, HostView } from './hosts.ts';
import type { HostConfig } from './remote.ts';

// list and create name a remote host by id; other requests carry it in the session ID prefix.
export type DesktopRequest = Exclude<Request, { type: 'auth' | 'hook' | 'shutdown' | 'desktop-register' | 'desktop-exit' | 'workspace' | 'list' | 'create' | 'system'
  | 'remote-list' | 'remote-screen' | 'remote-text' | 'remote-key' | 'remote-close' | 'remote-create' | 'upload' }>
  | { type: 'list'; host?: string } | { type: 'create'; options: CreateOptions; host?: string }
  // Answered with null when the host's daemon cannot be asked (disconnected, or too old to know it).
  | { type: 'system'; host?: string };
// host is 'local' for this machine's daemon; removed marks a host deleted from the list.
export type DesktopEvent = ServerEvent | { type: 'connection'; host: string; connected: boolean; error?: string; removed?: boolean }
  | { type: 'hosts'; hosts: HostView[] };
// A session as the renderer sees it: remote ones carry their host and a prefixed session ID.
export type DesktopSession = SessionInfo & { host?: string };
export type HostDraft = Omit<HostConfig, 'id'>;
export type HostRequest = { type: 'list' } | { type: 'check'; host: HostDraft } | { type: 'add'; host: HostDraft }
  | { type: 'probe'; host: HostDraft } | { type: 'trust'; host: HostDraft; fingerprint: string } | { type: 'deploy'; host: HostDraft; password: string }
  | { type: 'update'; id: string; host: HostDraft } | { type: 'remove'; id: string; revoke?: boolean } | { type: 'reconnect' | 'disconnect'; id: string };
// The host key seen during a first connection, compared with tarmac_known_hosts and the user's known_hosts.
export interface HostProbe { fingerprint: string; keyType: string; status: 'unknown' | 'match' | 'changed'; previous: string[] }
export interface HostCheck { ok: boolean; steps: CheckStep[]; firstConnect?: boolean }
export type { CheckStep, HostView };
export interface DesktopMetadata {
  cwd: string;
  shell: string;
  shellArgs: string[];
  dataDir: string;
  platform: string;
  // Linux xrdp session: rendering is software-only, so the renderer avoids idle repaints.
  remoteDisplay: boolean;
  connected: boolean;
  version: string;
  smoke: boolean;
}
// Project history and git branch, owned by the main process.
export type WorkspaceRequest = ({ type: 'view'; current?: string } | { type: 'touch'; path: string } | { type: 'clear'; keep: string[] }) & { host?: string };
// Shell startup files that exec tmux: plan is kept in the main process; apply only uses that plan.
export type ShellRcRequest = { type: 'plan' } | { type: 'apply' } | { type: 'undo' };
export type ShellRcResult = { plan: RcPlan } | { changed: string[]; backups: string[] };
// One-click install of Tarmac's own hooks; the plan is kept in the main process.
export type HookProvider = 'claude' | 'kimi' | 'agy';
export type HookStatus = { state: 'missing' | 'stale' | 'current' } | { state: 'unavailable'; reason: string };
export interface HookPlanView { provider: HookProvider; target: string; command: string; adds: string[]; removes: { event: string; command: string }[] }
export interface HookApplied { target: string; backup?: string }
export type HookRequest = { type: 'status'; provider: HookProvider } | { type: 'plan'; provider: HookProvider } | { type: 'apply' } | { type: 'undo' };
export interface DesktopBridge {
  ready(): Promise<DesktopMetadata>;
  workspace(request: WorkspaceRequest): Promise<WorkspaceView | null>;
  request<T = unknown>(request: DesktopRequest): Promise<T>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  shellRc(request: ShellRcRequest): Promise<ShellRcResult>;
  hooks(request: { type: 'status'; provider: HookProvider }): Promise<HookStatus>;
  hooks(request: { type: 'plan'; provider: HookProvider }): Promise<HookPlanView>;
  hooks(request: { type: 'apply' }): Promise<HookApplied>;
  hooks(request: { type: 'undo' }): Promise<{ target: string }>;
  hosts(request: { type: 'list' }): Promise<HostView[]>;
  hosts(request: { type: 'check'; host: HostDraft }): Promise<HostCheck>;
  hosts(request: { type: 'deploy'; host: HostDraft; password: string }): Promise<HostCheck>;
  hosts(request: { type: 'probe'; host: HostDraft }): Promise<HostProbe>;
  hosts(request: { type: 'add'; host: HostDraft }): Promise<HostView>;
  hosts(request: Exclude<HostRequest, { type: 'list' | 'check' | 'deploy' | 'probe' | 'add' }>): Promise<null>;
  // Saves an image on the session's machine and resolves with its path: the given bytes (a dropped
  // file), or this machine's clipboard image when data is absent (null if it holds no image).
  uploadImage(request: Identity & { data?: Uint8Array }): Promise<string | null>;
}

export const LOCAL_HOST = 'local';
// Daemon session IDs are UUIDs, so only a remote session's prefixed ID contains the separator.
export const remoteId = (host: string, sessionId: string): string => `${host}:${sessionId}`;
export function splitId(value: string): { host: string; sessionId: string } {
  const index = value.indexOf(':');
  return index < 0 ? { host: LOCAL_HOST, sessionId: value } : { host: value.slice(0, index), sessionId: value.slice(index + 1) };
}

export function identityOf(value: Identity): Identity {
  return { sessionId: value.sessionId, instanceId: value.instanceId };
}

export function createRequest(options: CreateOptions): DesktopRequest {
  return { type: 'create', options };
}

declare global {
  interface Window {
    tarmac: DesktopBridge;
    tarmacSmoke?: {
      start(): Promise<void>;
      state(): { text: string; ready: boolean; sessionId?: string; instanceId?: string; pid?: number; attachMs?: number; error?: string };
    };
  }
}
