import type { Activity, AgentKind, SessionInfo, SystemSample } from '../../../packages/protocol/src/index.ts';
import { LOCAL_HOST } from './bridge.ts';
import type { HostView } from './bridge.ts';

type HostState = HostView['state'];

// View models for the sidebar and history panel; the visual design is docs/design/app-ui.html.
const RECENT_LIMIT = 10;

export type Brand = AgentKind | 'shell';
export const BRANDS: Record<Brand, { name: string }> = {
  claude: { name: 'Claude' },
  codex: { name: 'Codex' },
  kimi: { name: 'Kimi' },
  agy: { name: 'Antigravity' },
  shell: { name: 'Shell' },
};
export const ACTIVITY_LABELS: Record<Activity, string> = {
  running: '运行中', working: '工作中', permission: '等待授权', waiting: '等待输入', idle: '空闲', exited: '已退出',
};
export const APPROVAL_HINT = '需要你选择，切过去处理';

export interface SessionRow {
  brand: Brand;
  name: string;
  // Absent for a shell without an agent, as in the TUI.
  activity?: Activity;
  // First non-empty line of the latest input record, or the approval hint.
  preview: string;
  hint: boolean;
  unread: number;
}
export interface SidebarModel {
  groups: { path: string; name: string; branch: string; collapsed: boolean;
    sessions: (SessionRow & { sessionId: string; active: boolean })[] }[];
  recent: { path: string; name: string }[];
  count: number;
}

// Backslash separates only in Windows paths; on POSIX it is an ordinary name character.
export const baseName = (dir: string): string => {
  const separator = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir) ? /[\\/]+/ : /\/+/;
  return dir.replace(new RegExp(`(?:${separator.source})$`), '').split(separator).pop() || dir;
};

export interface QuotaWindow {
  period: string;
  usedPercent: number;
  reset: string;
  tone: 'ok' | 'warn' | 'danger';
}
export function tokenUsageModel(info: SessionInfo | null, now = Date.now()): {
  label: string; detail: string; limits?: string; limitsDetail?: string; windows?: QuotaWindow[]; available?: boolean;
} | null {
  const current = info?.alive ? info.foreground : undefined;
  if (!info || (current?.provider !== 'claude' && current?.provider !== 'codex' && current?.provider !== 'kimi'
    && current?.provider !== 'agy')) return null;
  const usage = info.usage;
  if (!usage || usage.provider !== current.provider || usage.agentRunId !== String(current.pid)
    || (info.agent && usage.agentSessionId !== info.agent.agentSessionId)
    || ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens]
      .every(value => Number.isSafeInteger(value) && value >= 0)) {
    // Shared-daemon Codex has no reliable TUI -> thread mapping. Omit usage
    // without an exact association while preserving its launch mode.
    if (current.provider !== 'claude') return null;
    return { label: 'Token · 暂无数据', detail: info.usageError ?? '等待当前会话的用量数据' };
  }
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(usage.totalTokens);
  const exact = (value: number) => value.toLocaleString('en-US');
  const limits = usage.rateLimits;
  // A named window (a calendar month) has no fixed length and carries its own label.
  const windows = limits?.windows.filter(window => Number.isSafeInteger(window.windowMinutes)
    && (window.windowMinutes > 0 || (window.windowMinutes === 0 && typeof window.period === 'string' && window.period.length > 0))
    && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100
    && Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0
    && Number.isFinite(new Date(window.resetsAt * 1000).getTime())) ?? [];
  const period = (window: { windowMinutes: number; period?: string }) => window.period
    ?? (window.windowMinutes % 1440 === 0 ? `${window.windowMinutes / 1440}d`
      : window.windowMinutes % 60 === 0 ? `${window.windowMinutes / 60}h` : `${window.windowMinutes}m`);
  const reset = (seconds: number) => {
    const minutes = Math.max(0, Math.ceil((seconds * 1000 - now) / 60000));
    if (!minutes) return '待更新';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    const rest = minutes % 60;
    return days ? `${days}d${hours}h` : hours ? `${hours}h${rest}m` : `${rest}m`;
  };
  const quotaWindows: QuotaWindow[] = windows.map(window => ({ period: period(window),
    usedPercent: window.usedPercent, reset: reset(window.resetsAt),
    tone: window.usedPercent < 50 ? 'ok' : window.usedPercent < 80 ? 'warn' : 'danger' }));
  return { label: `Token ${compact}${usage.scope === 'observed' ? '（接入后）' : ''}`, available: true, detail: [
    `${usage.scope === 'observed' ? '接入后已捕获请求累计（不含历史与缺失事件）' : '当前会话累计'}：${exact(usage.totalTokens)} tokens`,
    `输入（含缓存）：${exact(usage.inputTokens)}`,
    `输出：${exact(usage.outputTokens)}`,
    `缓存读取：${exact(usage.cacheReadTokens)}`,
    `缓存写入：${exact(usage.cacheWriteTokens)}`,
  ].join('\n'),
    windows: quotaWindows,
    limits: windows.length ? quotaWindows.map(window => `${window.period} 已用 ${window.usedPercent}% · ${window.reset}`).join(' ｜ ')
      : '配额 · 暂无数据',
    limitsDetail: windows.length ? [limits!.source === 'account' ? '账户配额（来自账户接口）'
      : limits!.source === 'shared' ? '账户配额（同一账户其他会话记录的快照）' : '账户配额（当前会话记录的快照）',
      ...windows.map(window => `${period(window)} 已用 ${window.usedPercent}%：${new Date(window.resetsAt * 1000).toLocaleString()} 复位`),
      `数据时间：${limits!.observedAt}`, '倒计时到零后等待新快照，不推算剩余额度',
    ].join('\n') : '当前会话尚无可用的配额快照',
  };
}

function lastInput(info: SessionInfo): string {
  const prompt = info.history.records.at(-1)?.prompt ?? '';
  for (const line of prompt.split('\n')) if (line.trim()) return line.trim();
  return '';
}

export function sessionRow(info: SessionInfo): SessionRow {
  const provider = info.foreground?.provider;
  const activity = provider ? (info.agent?.provider === provider ? info.agent.activity : 'running') : undefined;
  const hint = activity === 'permission';
  const brand = provider ?? 'shell';
  const name = provider === 'codex' && info.foreground?.profile ? `Codex · ${info.foreground.profile}` : BRANDS[brand].name;
  const foreign = info.agent && info.agent.provider !== provider;
  return { brand, name, activity, preview: foreign ? '' : hint ? APPROVAL_HINT : lastInput(info), hint,
    unread: foreign ? 0 : info.history.unread };
}

export function liveDir(info: SessionInfo): string {
  return info.foreground?.cwd ?? info.cwd;
}

// projects is most recently opened first; the live session's directory is not repeated as history.
export function sidebarModel(infos: SessionInfo[], currentId: string | null, branches: Record<string, string>, projects: string[], collapsed: Set<string>): SidebarModel {
  const groups = new Map<string, SidebarModel['groups'][number]>();
  for (const info of infos) {
    if (!info.alive) continue;
    const path = liveDir(info);
    let group = groups.get(path);
    if (!group) {
      group = { path, name: baseName(path), branch: branches[path] ?? '', collapsed: collapsed.has(path), sessions: [] };
      groups.set(path, group);
    }
    group.sessions.push({ ...sessionRow(info), sessionId: info.sessionId, active: info.sessionId === currentId });
  }
  return {
    groups: [...groups.values()],
    recent: projects.filter(dir => !groups.has(dir)).slice(0, RECENT_LIMIT).map(dir => ({ path: dir, name: baseName(dir) })),
    count: infos.filter(info => info.alive).length,
  };
}

// Remote hosts first, in the order they were added, then this machine (docs/app-remote-spec.md).
// Without remote hosts the sidebar has a single untitled section, as before.
export interface HostMeta { id: string; name: string; address?: string; state: HostState | 'local'; error?: string; retryAt?: number }
export interface HostSection extends HostMeta {
  // Remote and not connected: rows keep their last known values, shown as unknown.
  offline: boolean;
  model: SidebarModel;
}
export const hostKey = (host: string, dir: string): string => `${host}\0${dir}`;
export function hostSections(infos: (SessionInfo & { host?: string })[], currentId: string | null, branches: Record<string, string>,
  projects: Record<string, string[]>, collapsed: Set<string>, remotes: HostMeta[]): HostSection[] {
  const hosts: HostMeta[] = [...remotes, { id: LOCAL_HOST, name: '本机', state: 'local' }];
  return hosts.map(meta => {
    const own = infos.filter(info => (info.host ?? LOCAL_HOST) === meta.id);
    const prefix = hostKey(meta.id, '');
    const pick = (keys: Iterable<string>) => [...keys].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    const model = sidebarModel(own, currentId, Object.fromEntries(pick(Object.keys(branches)).map(dir => [dir, branches[hostKey(meta.id, dir)]])),
      projects[meta.id] ?? [], new Set(pick(collapsed)));
    return { ...meta, offline: meta.state !== 'local' && meta.state !== 'connected', model };
  });
}

export function hostStatus(meta: HostMeta, now = Date.now()): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  switch (meta.state) {
    case 'local': return { label: '本机', tone: 'ok' };
    case 'connected': return { label: '已连接', tone: 'ok' };
    case 'connecting': return { label: '连接中', tone: 'warn' };
    case 'version': return { label: '版本不一致', tone: 'warn' };
    case 'stopped': return { label: '已断开', tone: 'bad' };
    case 'waiting': return { label: `重连中 ${Math.max(1, Math.ceil(((meta.retryAt ?? now) - now) / 1000))}s`, tone: 'bad' };
  }
}

export function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '????';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export interface HistoryModel {
  records: { id: string; time: string; text: string }[];
  diagnostics: [string, string][];
  alerts: string[];
  notes: string[];
}

export function historyModel(info: SessionInfo | null): HistoryModel {
  if (!info) return { records: [], diagnostics: [['状态', '无运行中的会话']], alerts: [], notes: [] };
  const hooks = info.hooks;
  const foreign = info.agent && info.agent.provider !== info.foreground?.provider;
  const activity = !info.alive ? `已退出（${info.exitCode ?? '未知'}）`
    : foreign ? '运行中' : info.agent ? ACTIVITY_LABELS[info.agent.activity] : info.foreground?.provider ? '运行中' : 'Shell';
  const notes = [info.history.displayNote, info.agent?.reason,
    hooks.verified ? undefined : '输入记录尚未接入'].filter((text): text is string => Boolean(text));
  const alerts = [
    info.replay?.exact === false ? `画面恢复降级：${info.replay.reason ?? '原因未知'}` : undefined,
    info.error, hooks.error, hooks.configError && `配置检测：${hooks.configError}`, info.history.error,
  ].filter((text): text is string => Boolean(text));
  return {
    records: foreign ? [] : info.history.records.map(record => ({ id: record.eventId, time: formatTime(record.at), text: record.prompt.trim() })),
    diagnostics: [
      ['状态', `${activity} · PID ${info.pid}`],
      ['hooks', hooks.verified ? '已验证' : hooks.configured ? '待验证' : '未配置'],
      ['恢复', info.replay?.exact === false ? '降级' : '字节回放'],
    ],
    alerts,
    notes,
  };
}

// Title bar figures from two `system` samples of one host; rates need the previous sample.
export interface SystemModel {
  // That machine's local time; null when its daemon does not report a UTC offset.
  clock: string | null;
  cpu: string | null;
  cpuTone: '' | 'warn' | 'danger';
  mem: string;
  memTone: '' | 'warn' | 'danger';
  net: string | null;
  detail: string;
}
const GIB = 1024 ** 3;
const loadTone = (percent: number): SystemModel['cpuTone'] => percent < 70 ? '' : percent < 90 ? 'warn' : 'danger';
// Four characters wide so the title bar does not shift as the figures change.
export function formatRate(bytesPerSecond: number): string {
  let value = Math.max(0, bytesPerSecond) / 1024;
  let unit = 'K';
  for (const next of ['M', 'G']) {
    if (value < 999.5) break;
    value /= 1024;
    unit = next;
  }
  return (value < 9.95 ? value.toFixed(1) : String(Math.round(value))).padStart(3) + unit;
}
export function formatClock(at: number, utcOffset: number): string {
  const time = new Date(at + utcOffset * 60_000);
  return `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}`;
}
const formatOffset = (minutes: number): string =>
  `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
export function systemModel(previous: SystemSample | null, sample: SystemSample): SystemModel {
  const hasOffset = Number.isInteger(sample.utcOffset) && Math.abs(sample.utcOffset!) <= 16 * 60;
  const dTotal = previous ? sample.cpuTotal - previous.cpuTotal : 0;
  const cpuPercent = dTotal > 0 ? Math.min(100, Math.max(0, Math.round((1 - (sample.cpuIdle - previous!.cpuIdle) / dTotal) * 100))) : null;
  const used = Math.max(0, sample.memTotal - sample.memAvailable);
  const memPercent = sample.memTotal > 0 ? Math.round(used / sample.memTotal * 100) : 0;
  const seconds = previous ? (sample.at - previous.at) / 1000 : 0;
  // A counter that went backwards (interface removed, counter reset) reads as no traffic.
  const rate = (now: number, before: number): number => Math.max(0, now - before) / seconds;
  const net = previous?.net && sample.net && seconds > 0
    ? { down: rate(sample.net.rx, previous.net.rx), up: rate(sample.net.tx, previous.net.tx) } : null;
  return {
    clock: hasOffset ? formatClock(sample.at, sample.utcOffset!) : null,
    cpu: cpuPercent === null ? null : `${String(cpuPercent).padStart(3)}%`,
    cpuTone: cpuPercent === null ? '' : loadTone(cpuPercent),
    mem: `${(used / GIB).toFixed(1)}/${(sample.memTotal / GIB).toFixed(1)}G`,
    memTone: loadTone(memPercent),
    net: net ? `↓${formatRate(net.down)} ↑${formatRate(net.up)}` : null,
    detail: [
      `CPU ${cpuPercent === null ? '采样中' : `${cpuPercent}%`}（${sample.cores} 核）`,
      `内存 已用 ${(used / GIB).toFixed(1)} GiB / 共 ${(sample.memTotal / GIB).toFixed(1)} GiB（${memPercent}%）`,
      ...hasOffset ? [`时间 ${formatClock(sample.at, sample.utcOffset!)}（${formatOffset(sample.utcOffset!)}）`] : [],
      sample.net ? `网络 每秒${net ? ` 下载 ${formatRate(net.down).trim()}B 上传 ${formatRate(net.up).trim()}B` : '采样中'}，不含回环与虚拟网卡` : '网络 此平台未采集',
    ].join('\n'),
  };
}
