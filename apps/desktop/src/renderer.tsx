import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import type { ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { SessionInfo, CreateOptions, Identity, SystemSample } from '../../../packages/protocol/src/index.ts';
import { LIMITS, UPLOAD_MAX_BYTES } from '../../../packages/protocol/src/index.ts';
import type { CheckStep, DesktopMetadata, DesktopEvent, DesktopSession, HookApplied, HookPlanView, HookProvider, HostDraft, HostProbe, HostView, ShellRcResult } from './bridge.ts';
import type { RcPlan } from '../../../packages/cli/src/shell-rc.ts';
import { LOCAL_HOST, identityOf, splitId } from './bridge.ts';
import { SESSION_BUSY } from '../../../packages/protocol/src/index.ts';
import type { WorkspaceView } from './projects.ts';
import { ACTIVITY_LABELS, formatTime, historyModel, hostKey, hostSections, hostStatus, systemModel, tokenUsageModel, liveDir } from './panels.ts';
import logoUrl from '../assets/tarmac.svg';
import type { HistoryModel, HostSection, SidebarModel, SystemModel } from './panels.ts';
import { suppressTerminalQueries } from './query-guard.ts';
import { TerminalStream } from './terminal-stream.ts';
import type { StreamTerminal } from './terminal-stream.ts';
import { BrandIcon, BranchIcon } from './icons.tsx';
import '@xterm/xterm/css/xterm.css';
import './style.css';

const FONT_CREDIT = '字体：Ubuntu Sans Mono、Ubuntu（Canonical）；中文字体 MiSans（小米）';

// Font and cell grid match GNOME Terminal at 12 pt (Ubuntu Sans Mono with
// MiSans fallback); colors follow docs/design/app-ui.html.
const TERMINAL_OPTIONS: ITerminalOptions = {
  fontFamily: '"Ubuntu Sans Mono", "MiSans", monospace',
  fontSize: 16,
  // VTE rounds cells to 18x44 device pixels at 2x (9x22 CSS); xterm's raw font
  // metrics give 17x38, so widen and heighten the cell to the same grid.
  letterSpacing: 0.5,
  lineHeight: 1.16,
  allowProposedApi: true,
  drawBoldTextInBrightColors: false,
  cursorStyle: 'block',
  theme: {
    background: '#121417', foreground: '#e4e7ea', cursor: '#e4e7ea', cursorAccent: '#121417',
    black: '#171421', red: '#c01c28', green: '#26a269', yellow: '#a2734c', blue: '#12488b', magenta: '#a347ba', cyan: '#2aa1b3', white: '#d0cfcc',
    brightBlack: '#5e5c64', brightRed: '#f66151', brightGreen: '#33da7a', brightYellow: '#e9ad0c', brightBlue: '#2a7bde',
    brightMagenta: '#c061cb', brightCyan: '#33c7de', brightWhite: '#ffffff',
  },
};
// Used only to size a new PTY before its terminal exists; fit corrects it on attach.
const CELL = { width: 9, height: 22 };
function loadRenderer(term: Terminal): WebglAddon | null {
  try {
    const webgl = new WebglAddon();
    term.loadAddon(webgl);
    webgl.onContextLoss(() => webgl.dispose());
    return webgl;
  } catch { return null; /* DOM rendering remains usable without WebGL. */ }
}

// One resident terminal per live session: it keeps receiving output in the background, so a
// switch only changes which one is displayed instead of replaying the session from the start.
interface Pane {
  identity: Identity;
  container: HTMLDivElement;
  stream: TerminalStream;
  term: Terminal | null;
  fit: FitAddon | null;
  // Only the displayed terminal holds a WebGL context; Chromium caps how many may exist.
  webgl: WebglAddon | null;
  // An attach was requested and control has not been taken away since.
  attached: boolean;
  // Another connection controls the session; only the explicit takeover (在这里继续) takes it back.
  yielded: boolean;
  faults: number;
  // Connections lost while this pane was replaying, without becoming ready in between.
  drops: number;
  // Stopped retrying after repeated failures; only clicking the session tries again.
  blocked: boolean;
}

// A session that breaks the connection or its stream this often is not retried automatically,
// so one bad session cannot keep the whole App reconnecting forever.
const PANE_RETRIES = 3;

const hostOf = (value: { host?: string } | null | undefined): string => value?.host ?? LOCAL_HOST;
const hostAddress = (host: HostView): string => host.user ? `${host.user}@${host.address}` : host.address;

const SYSTEM_POLL_MS = 2000;
const clockText = (): string => formatTime(new Date().toISOString());

// Figures and local time of the machine the session runs on (host: remote host id, absent for this
// machine). A remote clock needs that host's answer; this machine's falls back to the App's own.
// Its own timer keeps the 2 s refresh from re-rendering the rest of the title bar.
function SystemStats({ host, offline }: { host?: string; offline: boolean }): React.JSX.Element {
  const [view, setView] = useState<SystemModel | null>(null);
  const [clock, setClock] = useState(clockText);
  useEffect(() => {
    let previous: SystemSample | null = null;
    let stopped = false;
    let busy = false;
    setView(null);
    const tick = async (): Promise<void> => {
      setClock(clockText());
      // Nothing is sampled while the window is hidden; the next rate starts from a fresh sample.
      if (offline || document.hidden) { previous = null; if (offline) setView(null); return; }
      if (busy) return;
      busy = true;
      const sample = await window.tarmac.request<SystemSample | null>({ type: 'system', ...(host ? { host } : {}) }).catch(() => null);
      busy = false;
      if (stopped) return;
      setView(sample ? systemModel(previous, sample) : null);
      previous = sample;
    };
    void tick();
    const timer = window.setInterval(() => void tick(), SYSTEM_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [host, offline]);
  const shownClock = view?.clock ?? (host ? null : clock);
  return <span className="system-stats" title={view?.detail} aria-label={view?.detail}>
    {view && <>
      {view.cpu && <span className="sys-cpu"><span className={view.cpuTone}>{view.cpu}</span></span>}
      <span className="sys-mem"><span className={view.memTone}>{view.mem}</span></span>
      {view.net && <span className="sys-net">{view.net}</span>}
    </>}
    {shownClock && <span className="sys-clock">{shownClock}</span>}
  </span>;
}

function Titlebar({ session, host, offline }: { session: SessionInfo | null; host?: HostView; offline: boolean }): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const usage = offline ? null : tokenUsageModel(session, now);
  // The MiSans licence requires the software to state that it uses MiSans.
  return <header className="titlebar"><span className="brand" title={FONT_CREDIT}><img src={logoUrl} alt="" width="18" height="18" />Tarmac</span>
    {host && <span className={offline ? 'host-chip offline' : 'host-chip'} title={hostAddress(host)}><span className="host-dot" />{host.name}{offline && ' · 已断开'}</span>}
    {usage && <span className={`token-usage${usage.available ? ' available' : ''}`} title={usage.detail} aria-label={usage.detail}>{usage.label}</span>}
    {usage?.limits && <span className="quota-usage" title={usage.limitsDetail} aria-label={usage.limitsDetail}>
      {usage.windows?.length ? usage.windows.map((window, index) => <React.Fragment key={index}>
        {index > 0 && <span className="quota-separator"> ｜ </span>}
        <span className="quota-period">{window.period}</span>{' 已用 '}
        <span className={`quota-percent ${window.tone}`}>{window.usedPercent}%</span>{' · '}
        <span className="quota-reset">{window.reset}</span>
      </React.Fragment>) : usage.limits}
    </span>}
    <SystemStats host={host?.id} offline={offline} />
  </header>;
}

type HostAction = 'new' | 'reconnect' | 'disconnect' | 'edit' | 'remove';
const folder = <svg className="folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.1l1.4 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" /></svg>;

function SessionGroups({ host, model, offline, onSession, onToggle, onProject, onClearRecent }: {
  host: string; model: SidebarModel; offline: boolean;
  onSession(sessionId: string): void; onToggle(host: string, path: string): void; onProject(host: string, path: string): void;
  onClearRecent(host: string): void;
}): React.JSX.Element {
  // Clearing takes a second click within 3 seconds, so one stray click cannot empty the list.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return <>
    {model.groups.length > 0 && <div className="section">当前任务 {model.count}</div>}
    {model.groups.map(group => <div key={group.path} className={group.collapsed ? 'group collapsed' : 'group'}>
        <button className="group-row" onClick={() => onToggle(host, group.path)} title={group.path}>
          <svg className="chev" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2.5 4.2h7L6 8.3z" /></svg>{folder}
          <span className="project">{group.name}</span>
          {group.branch && <span className="branch" title={group.branch}><BranchIcon /><span className="branch-name">{group.branch}</span></span>}
        </button>
        <div className="sessions">
          {group.sessions.map(session => {
            // A disconnected host's last known state is not presented as current.
            const activity = offline ? 'stale' : session.activity;
            return <button key={session.sessionId} data-session-id={session.sessionId}
              className={session.active ? 'session active' : 'session'} onClick={() => onSession(session.sessionId)}>
              <span className="identity">
                <span className={`logo brand-${session.brand}`}><BrandIcon brand={session.brand} /></span>
                <span className="brand" title={session.name}>{session.name}</span>
                {activity && <span className={`state ${activity}`}><span className="dot" />{activity === 'stale' ? '状态未知' : ACTIVITY_LABELS[activity]}</span>}
                {session.unread > 0 && <span className="unread">+{session.unread}</span>}
              </span>
              {session.preview && <span className={session.hint ? 'preview hint' : 'preview'}>{session.preview}</span>}
            </button>;
          })}
        </div>
      </div>)}
    {model.recent.length > 0 && <>
      <div className="section recent-title section-row">历史项目 {model.recent.length}
        <button className={armed ? 'clear-recent armed' : 'clear-recent'} title="清除这台主机的历史项目，不影响正在运行的会话"
          onClick={() => { if (armed) { setArmed(false); onClearRecent(host); } else setArmed(true); }}>{armed ? '确认清除' : '清除'}</button></div>
      {model.recent.map(project => <button key={project.path} className="recent" title={project.path} onClick={() => onProject(host, project.path)}>
        {folder}<span className="project">{project.name}</span><span className="open">新建 Shell</span>
      </button>)}
    </>}
  </>;
}

function HostHeader({ section, hosts, now, onAction }: { section: HostSection; hosts: HostView[]; now: number; onAction(id: string, action: HostAction): void }): React.JSX.Element {
  const [menu, setMenu] = useState(false);
  const status = hostStatus(section, now);
  const host = hosts.find(item => item.id === section.id);
  const run = (action: HostAction): void => { setMenu(false); onAction(section.id, action); };
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);
  return <div className="host-row">
    {host ? <ServerIcon /> : <ComputerIcon />}
    <span className="host-name">{section.name}</span>
    {host && <span className="host-addr" title={hostAddress(host)}>{hostAddress(host)}</span>}
    <span className={`conn ${status.tone}`}><span className="conn-dot" />{status.label}</span>
    <button className="more" aria-label={`${section.name} 菜单`} onClick={event => { event.stopPropagation(); setMenu(value => !value); }}>⋯</button>
    {/* This machine has only 新建 Shell: Ctrl+Shift+N follows a selected remote session onto its host. */}
    {menu && <div className="menu" role="menu" onClick={event => event.stopPropagation()}>
      {(section.state === 'connected' || section.state === 'local') && <button role="menuitem" onClick={() => run('new')}>新建 Shell</button>}
      {host && <>
        <button role="menuitem" onClick={() => run('reconnect')}>立即重连</button>
        {section.state !== 'stopped' && <button role="menuitem" onClick={() => run('disconnect')}>断开连接</button>}
        <button role="menuitem" onClick={() => run('edit')}>编辑主机…</button>
        <hr />
        <button role="menuitem" className="danger" onClick={() => run('remove')}>从列表移除</button>
      </>}
    </div>}
  </div>;
}

function HostNote({ section, onAction }: { section: HostSection; onAction(id: string, action: HostAction): void }): React.JSX.Element | null {
  if (section.state === 'version') {
    return <div className="host-note"><strong>两端版本不一致，未连接</strong><p>{section.error}；这台主机上的 agent 照常运行。</p>
      <div className="rc-actions"><button onClick={() => onAction(section.id, 'reconnect')}>重试</button></div></div>;
  }
  if (!section.offline || section.state === 'connecting' && !section.error) return null;
  const known = section.model.count > 0;
  return <div className="host-note bad">
    <strong>{section.state === 'stopped' || known ? `与 ${section.name} 的连接已断开` : `无法连接 ${section.name}`}</strong>
    <p>{section.error && section.error !== '已手动断开' ? section.error + '。' : ''}{known ? `agent 仍在 ${section.name} 上运行，下方是断开前的状态，重连后自动刷新。` : ''}</p>
    <div className="rc-actions"><button onClick={() => onAction(section.id, 'reconnect')}>立即重连</button></div>
  </div>;
}

function ServerIcon(): React.JSX.Element {
  return <svg className="host-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2" y="2" width="12" height="5" rx="1" /><rect x="2" y="9" width="12" height="5" rx="1" /><path d="M4.6 4.5h.01M4.6 11.5h.01" strokeWidth="2" strokeLinecap="round" /></svg>;
}
function ComputerIcon(): React.JSX.Element {
  return <svg className="host-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.2" /><path d="M5.5 13.6h5M8 11v2.6" /></svg>;
}

function Sidebar({ sections, hosts, error, onSession, onToggle, onProject, onClearRecent, onHistory, onNew, onAddHost, onHostAction }: {
  sections: HostSection[]; hosts: HostView[]; error: string;
  onSession(sessionId: string): void; onToggle(host: string, path: string): void; onProject(host: string, path: string): void;
  onClearRecent(host: string): void;
  onHistory(): void; onNew(): void; onAddHost(): void; onHostAction(id: string, action: HostAction): void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  const counting = hosts.some(host => host.state === 'waiting');
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);
  const titled = sections.length > 1;
  return <aside className="side" aria-label="会话">
    <div className="side-body">
      {sections.map(section => <div key={section.id} className={section.offline ? 'host offline' : 'host'} data-host={section.id}>
        {titled && <HostHeader section={section} hosts={hosts} now={now} onAction={onHostAction} />}
        {titled && <HostNote section={section} onAction={onHostAction} />}
        {section.state !== 'version' && <SessionGroups host={section.id} model={section.model} offline={section.offline}
          onSession={onSession} onToggle={onToggle} onProject={onProject} onClearRecent={onClearRecent} />}
        {/* A new host has neither sessions nor history to start from. */}
        {titled && section.state === 'connected' && !section.model.groups.length && !section.model.recent.length
          && <button className="recent host-new" onClick={() => onHostAction(section.id, 'new')}>{folder}<span className="project">暂无会话</span><span className="open">新建 Shell</span></button>}
      </div>)}
      <button className="add-host" onClick={onAddHost}>＋ 添加远程主机</button>
    </div>
    <div className="side-foot">
      {error && <div className="error" role="alert">{error}</div>}
      <div className="keys">
        <button onClick={onHistory}><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>H</kbd>历史</button>
        <button onClick={onNew}><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>N</kbd>新建</button>
      </div>
    </div>
  </aside>;
}

function History({ model, onClose }: { model: HistoryModel; onClose(): void }): React.JSX.Element {
  return <aside className="history" aria-label="输入记录">
    <div className="history-head"><h2>History</h2><span className="mode">会话</span><button className="close" onClick={onClose}>Ctrl+Shift+H 隐藏</button></div>
    <div className="records">
      {model.records.length ? model.records.map(record => <article className="record" key={record.id}><time>{record.time}</time><p>{record.text}</p></article>)
        : <p className="none">暂无历史</p>}
    </div>
    <div className="diag">
      <dl>{model.diagnostics.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
      {model.notes.map(note => <p key={note} className="note">{note}</p>)}
      {model.alerts.map(alert => <p key={alert} className="alert">{alert}</p>)}
    </div>
  </aside>;
}

type RcStage = { stage: 'notice' } | { stage: 'busy' } | { stage: 'plan'; plan: RcPlan }
  | { stage: 'done'; changed: string[]; backups: string[]; undone?: boolean } | { stage: 'error'; message: string };

// Shown while the current terminal is a shell that exec'd into tmux: agents inside it cannot be seen.
function ShellTakeover({ onNew, onDismiss }: { onNew(): void; onDismiss(): void }): React.JSX.Element {
  const [state, setState] = useState<RcStage>({ stage: 'notice' });
  const run = (request: Parameters<typeof window.tarmac.shellRc>[0], undone = false): void => {
    setState({ stage: 'busy' });
    window.tarmac.shellRc(request).then((result: ShellRcResult) => {
      setState('plan' in result ? { stage: 'plan', plan: result.plan } : { stage: 'done', ...result, undone });
    }, (error: unknown) => setState({ stage: 'error', message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error) }));
  };
  const changes = state.stage === 'plan' ? state.plan.files.filter(file => file.changes.length) : [];
  const unrecognized = state.stage === 'plan' ? state.plan.files.filter(file => file.unrecognized.length) : [];
  return <section className="rc-card" role="dialog" aria-label="终端被 tmux 接管">
    <strong>此终端启动后自动进入了 tmux</strong>
    {state.stage === 'notice' && <>
      <p>shell 启动文件里会自动执行 tmux，agent 实际运行在 tmux 中，Tarmac 无法识别它的状态、用量和 hooks。可以只在 Tarmac 的终端里跳过自动启动，其他终端不受影响。</p>
      <div className="rc-actions"><button className="primary" onClick={() => run({ type: 'plan' })}>查看修复方案</button><button onClick={onDismiss}>忽略</button></div>
    </>}
    {state.stage === 'busy' && <p>处理中…</p>}
    {state.stage === 'plan' && <>
      {state.plan.unsupported && <p>{state.plan.unsupported}，请手动在自动启动 tmux 的条件中加入 <code>{'[[ -z "$TARMAC_SESSION_ID" ]]'}</code> 。</p>}
      {changes.map(file => <div key={file.file} className="rc-file">
        <p>{file.file}{file.symlink && <>（链接，实际修改 {file.target}）</>}</p>
        {file.changes.map(change => <div key={change.line}><span className="rc-line">第 {change.line} 行</span>
          <pre className="rc-before">{change.before}</pre><pre className="rc-after">{change.after.join('\n')}</pre></div>)}
      </div>)}
      {unrecognized.length > 0 && <div className="rc-file"><p>以下内容可能也会启动 tmux，无法自动处理，需要手动加入 <code>{'[[ -z "$TARMAC_SESSION_ID" ]]'}</code> 条件：</p>
        {unrecognized.flatMap(file => file.unrecognized.map(item => <pre key={file.file + item.line} className="rc-found">{file.file}:{item.line}  {item.text}</pre>))}</div>}
      {!state.plan.unsupported && !changes.length && !unrecognized.length && <p>没有在启动文件中找到自动启动 tmux 的写法，它可能在被 source 的其他文件里。</p>}
      {changes.length > 0 && <p className="rc-note">修改前会备份原文件；改动行带 # tarmac-app 标记，可随时撤销。新建终端后生效。</p>}
      <div className="rc-actions">{changes.length > 0 && <button className="primary" onClick={() => run({ type: 'apply' })}>授权修改</button>}<button onClick={onDismiss}>取消</button></div>
    </>}
    {state.stage === 'done' && <>
      <p>{state.undone ? '已撤销修改' : '已修改'}：{state.changed.join('、') || '无需改动'}。{state.backups.length > 0 && <>原文件备份在 {state.backups.join('、')}。</>}</p>
      <p>{state.undone ? '新建终端会重新自动进入 tmux。' : '新建终端后生效，当前终端仍在 tmux 中。'}</p>
      <div className="rc-actions">{!state.undone && <button className="primary" onClick={onNew}>新建终端</button>}
        {!state.undone && <button onClick={() => run({ type: 'undo' }, true)}>撤销修改</button>}<button onClick={onDismiss}>关闭</button></div>
    </>}
    {state.stage === 'error' && <><p className="rc-error">{state.message}</p><div className="rc-actions"><button onClick={() => setState({ stage: 'notice' })}>返回</button><button onClick={onDismiss}>关闭</button></div></>}
  </section>;
}

type HookStage = { stage: 'notice' } | { stage: 'busy' } | { stage: 'plan'; plan: HookPlanView }
  | { stage: 'done'; applied: HookApplied } | { stage: 'undone'; target: string } | { stage: 'error'; message: string };
const HOOK_NAMES: Record<HookProvider, string> = { claude: 'Claude Code', kimi: 'Kimi', agy: 'Antigravity' };
const ipcError = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);

// Offered while the current agent lacks Tarmac's hooks; writing needs the user's click on the plan.
function HooksCard({ provider, stale, onClose }: { provider: HookProvider; stale: boolean; onClose(): void }): React.JSX.Element {
  const [state, setState] = useState<HookStage>({ stage: 'notice' });
  const name = HOOK_NAMES[provider];
  const fail = (error: unknown): void => setState({ stage: 'error', message: ipcError(error) });
  const preview = (): void => { setState({ stage: 'busy' }); window.tarmac.hooks({ type: 'plan', provider }).then(plan => setState({ stage: 'plan', plan }), fail); };
  const apply = (): void => { setState({ stage: 'busy' }); window.tarmac.hooks({ type: 'apply' }).then(applied => setState({ stage: 'done', applied }), fail); };
  const undo = (): void => { setState({ stage: 'busy' }); window.tarmac.hooks({ type: 'undo' }).then(result => setState({ stage: 'undone', target: result.target }), fail); };
  return <section className="rc-card" role="dialog" aria-label={`${name} hooks`}>
    <strong>{stale ? `${name} 的 Tarmac hooks 指向旧位置` : `${name} 未安装 Tarmac hooks`}</strong>
    {state.stage === 'notice' && <>
      <p>{stale ? 'App 移动或升级后，配置里的 hook 命令仍指向原来的路径，状态、token 和输入记录会失效。'
        : '没有 hooks 时只能显示「运行中」，无法识别等待输入、等待授权、token 和输入记录。'}</p>
      <div className="rc-actions"><button className="primary" onClick={preview}>{stale ? '查看修复方案' : '查看安装方案'}</button><button onClick={onClose}>忽略</button></div>
    </>}
    {state.stage === 'busy' && <p>处理中…</p>}
    {state.stage === 'plan' && <>
      <p>修改 {state.plan.target}</p>
      {state.plan.removes.length > 0 && <div className="rc-file"><p>移除 {state.plan.removes.length} 个旧条目：</p>
        {[...new Set(state.plan.removes.map(item => item.command))].map(command => <pre key={command} className="rc-before">{command}</pre>)}</div>}
      <div className="rc-file"><p>新增 {state.plan.adds.length} 个事件：{state.plan.adds.join('、')}</p><pre className="rc-after">{state.plan.command} # tarmac-app</pre></div>
      <p className="rc-note">修改前会备份原文件；只增删带 # tarmac-app 标记的条目，可随时撤销。{provider === 'claude' && 'statusLine 不会改动。'}已在运行的 {name} 不会重新加载，新开的会话生效。</p>
      <div className="rc-actions"><button className="primary" onClick={apply}>授权安装</button><button onClick={onClose}>取消</button></div>
    </>}
    {state.stage === 'done' && <>
      <p>已写入 {state.applied.target}。{state.applied.backup && <>原文件备份在 {state.applied.backup}。</>}</p>
      <p>新开 {name} 会话后生效。</p>
      <div className="rc-actions"><button onClick={undo}>撤销</button><button className="primary" onClick={onClose}>关闭</button></div>
    </>}
    {state.stage === 'undone' && <><p>已撤销，{state.target} 已恢复为安装前的内容。</p><div className="rc-actions"><button onClick={onClose}>关闭</button></div></>}
    {state.stage === 'error' && <><p className="rc-error">{state.message}</p><div className="rc-actions"><button onClick={() => setState({ stage: 'notice' })}>返回</button><button onClick={onClose}>关闭</button></div></>}
  </section>;
}

// Adding or editing a remote host: the save button opens only after the checklist passes for the
// exact values shown. A failed key login or unknown host key leads to the one-time first connection:
// confirm the host key, then a password login that deploys Tarmac's key (docs/app-remote-spec.md).
type FirstStage = { stage: 'probing' } | { stage: 'trust'; probe: HostProbe } | { stage: 'password' } | { stage: 'deploying' };
function HostDialog({ host, onClose }: { host?: HostView; onClose(): void }): React.JSX.Element {
  const [fields, setFields] = useState({ name: host?.name ?? '', address: host?.address ?? '', user: host?.user ?? '',
    port: host?.port ? String(host.port) : '', command: host?.command ?? '' });
  const [check, setCheck] = useState<{ running: boolean; ok?: boolean; steps: CheckStep[]; error?: string }>({ running: false, steps: [] });
  const [first, setFirst] = useState<FirstStage | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const draft = (): HostDraft | string => {
    const port = fields.port.trim() ? Number(fields.port.trim()) : undefined;
    if (!fields.address.trim()) return '请填写地址';
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return '端口应为 1 到 65535 的整数';
    return { name: fields.name.trim() || fields.address.trim(), address: fields.address.trim(),
      ...(fields.user.trim() ? { user: fields.user.trim() } : {}), ...(port ? { port } : {}),
      ...(fields.command.trim() ? { command: fields.command.trim() } : {}) };
  };
  const edit = (name: keyof typeof fields) => (event: React.ChangeEvent<HTMLInputElement>): void => {
    setFields(previous => ({ ...previous, [name]: event.target.value }));
    setCheck({ running: false, steps: [] });
    setFirst(null);
  };
  const fail = (error: unknown, steps: CheckStep[] = []): void => { setFirst(null); setCheck({ running: false, steps, error: ipcError(error) }); };
  const probe = (value: HostDraft, steps: CheckStep[]): void => {
    setFirst({ stage: 'probing' });
    window.tarmac.hosts({ type: 'probe', host: value }).then(result => setFirst(result.status === 'match' ? { stage: 'password' } : { stage: 'trust', probe: result }),
      error => fail(error, steps));
  };
  const run = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    const value = draft();
    if (typeof value === 'string') { setCheck({ running: false, steps: [], error: value }); return; }
    setFirst(null);
    setCheck({ running: true, steps: [] });
    window.tarmac.hosts({ type: 'check', host: value }).then(result => {
      setCheck({ running: false, ok: result.ok, steps: result.steps });
      if (result.firstConnect) probe(value, result.steps);
    }, error => fail(error));
  };
  const trust = (fingerprint: string): void => {
    const value = draft();
    if (typeof value === 'string') return;
    window.tarmac.hosts({ type: 'trust', host: value, fingerprint }).then(() => {
      setCheck(previous => ({ ...previous, steps: [...previous.steps, { label: '主机指纹已保存', ok: true, detail: '~/.ssh/tarmac_known_hosts' }] }));
      setFirst({ stage: 'password' });
    }, error => fail(error, check.steps));
  };
  const deploy = (event: React.FormEvent): void => {
    event.preventDefault();
    const value = draft();
    if (typeof value === 'string' || !password) return;
    const secret = password;
    // The password leaves the renderer state as soon as it is sent.
    setPassword('');
    setFirst({ stage: 'deploying' });
    window.tarmac.hosts({ type: 'deploy', host: value, password: secret }).then(result => {
      setFirst(null);
      setCheck({ running: false, ok: result.ok, steps: result.steps });
    }, error => { setFirst({ stage: 'password' }); setCheck(previous => ({ ...previous, error: ipcError(error) })); });
  };
  const save = (): void => {
    const value = draft();
    if (typeof value === 'string') return;
    setSaving(true);
    (host ? window.tarmac.hosts({ type: 'update', id: host.id, host: value }) : window.tarmac.hosts({ type: 'add', host: value }))
      .then(() => onClose(), error => { setSaving(false); setCheck({ running: false, steps: [], error: ipcError(error) }); });
  };
  const target = `${fields.user.trim() ? fields.user.trim() + '@' : ''}${fields.address.trim()}${fields.port.trim() ? ':' + fields.port.trim() : ''}`;
  const busy = check.running || first?.stage === 'probing' || first?.stage === 'deploying';
  return <div className="scrim"><div className="dialog" role="dialog" aria-label={host ? '编辑远程主机' : '添加远程主机'}>
    <form className="dialog-form" onSubmit={run}>
      <h3>{host ? '编辑远程主机' : '添加远程主机'}</h3>
      <p>Tarmac 用 SSH 连接这台主机上的 daemon，不开放新端口；agent、hooks 和用量都在那台主机上处理。还不能免密登录的主机，第一次用密码登录，Tarmac 会部署自己的密钥。</p>
      <div className="fields">
        <label className="field wide">地址<input id="host-address" value={fields.address} onChange={edit('address')} placeholder="192.168.1.20" autoFocus spellCheck={false} />
          <span className="hint">局域网 IP、主机名，或 ~/.ssh/config 里的 Host 名（首次连接需要 IP 或主机名）</span></label>
        <label className="field">用户名<input id="host-user" value={fields.user} onChange={edit('user')} placeholder="留空用本机用户名" spellCheck={false} /></label>
        <label className="field">端口<input id="host-port" value={fields.port} onChange={edit('port')} placeholder="22" inputMode="numeric" /></label>
        <label className="field wide">显示名称<input id="host-name" value={fields.name} onChange={edit('name')} placeholder="留空用地址" /></label>
        <label className="field wide">远端命令<input id="host-command" value={fields.command} onChange={edit('command')} placeholder="留空用默认安装位置 ~/.local/opt/tarmac" spellCheck={false} /></label>
      </div>
      {(check.running || check.steps.length > 0) && <ol className="checks">
        {check.running && <li className="run"><span className="mark">…</span><span>正在连接并检查</span></li>}
        {check.steps.map(step => <li key={step.label} className={step.ok ? 'ok' : 'fail'}><span className="mark">{step.ok ? '✓' : '✕'}</span>
          <span>{step.label}{step.detail && <small>{step.detail}</small>}</span></li>)}
        {first?.stage === 'probing' && <li className="run"><span className="mark">…</span><span>读取主机指纹</span></li>}
        {first?.stage === 'deploying' && <li className="run"><span className="mark">…</span><span>用密码登录并部署密钥</span></li>}
      </ol>}
    </form>
    {first?.stage === 'trust' && <div className={first.probe.status === 'changed' ? 'trust warn' : 'trust'}>
      <strong>{first.probe.status === 'changed' ? '主机指纹已变化，确认后才会替换' : '首次连接这台主机，请核对主机指纹'}</strong>
      <dl><dt>主机</dt><dd>{target}</dd><dt>{first.probe.keyType}</dt><dd className="fingerprint">{first.probe.fingerprint}</dd>
        {first.probe.previous.map(item => <React.Fragment key={item}><dt>上次保存</dt><dd className="fingerprint old">{item}</dd></React.Fragment>)}</dl>
      <p>可以在那台主机上执行 <code>ssh-keygen -lf /etc/ssh/ssh_host_{first.probe.keyType.replace(/^ssh-|-.*$/g, '')}_key.pub</code> 对照。{first.probe.status === 'changed'
        ? '可能是那台机器重装了系统，也可能连到了冒充的机器；不确定时请拒绝。' : ''}接受后保存到 <code>~/.ssh/tarmac_known_hosts</code>。</p>
      <div className="rc-actions"><button className="primary" onClick={() => trust(first.probe.fingerprint)}>接受并保存</button>
        <button onClick={() => fail(new Error('已拒绝这个指纹，没有连接；确认是正确的机器后再重新检查'), check.steps)}>拒绝</button></div>
    </div>}
    {first?.stage === 'password' && <form className="trust" onSubmit={deploy}>
      <strong>用密码登录一次，部署 Tarmac 的密钥</strong>
      <label className="field">{target} 的密码<input id="host-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" autoFocus /></label>
      <p>密码只用这一次，不保存。Tarmac 在本机 <code>~/.ssh/tarmac_ed25519</code> 生成密钥（已有则复用），把公钥追加到对方的 <code>~/.ssh/authorized_keys</code> ，那一行只带 <code>tarmac-app</code> 标记、不含本机名称，移除主机时可以一并删掉。</p>
      <div className="rc-actions"><button type="submit" className="primary" disabled={!password}>用密码登录并部署密钥</button></div>
    </form>}
    {check.error && <p className="rc-error">{check.error}</p>}
    <div className="rc-actions dialog-actions">
      <button type="button" onClick={onClose}>取消</button>
      {check.ok ? <button type="button" className="primary" disabled={saving} onClick={save}>{host ? '保存' : '添加'}</button>
        : !first && <button type="button" className="primary" disabled={busy} onClick={run}>{check.steps.length ? '重新检查' : '连接并检查'}</button>}
    </div>
  </div></div>;
}

function RemoveHostDialog({ host, sessions, onClose }: { host: HostView; sessions: number; onClose(): void }): React.JSX.Element {
  const [error, setError] = useState('');
  const online = host.state === 'connected';
  // Removing Tarmac's line from the host's authorized_keys needs the host online.
  const [revoke, setRevoke] = useState(online);
  const [busy, setBusy] = useState(false);
  const remove = (): void => {
    setBusy(true);
    window.tarmac.hosts({ type: 'remove', id: host.id, revoke: revoke && online }).then(onClose, failure => { setBusy(false); setError(ipcError(failure)); });
  };
  return <div className="scrim"><div className="dialog" role="dialog" aria-label="移除远程主机">
    <h3>移除 {host.name}？</h3>
    <p>Tarmac 不再连接这台主机，左栏不再显示它的会话。{sessions > 0 ? `${host.name} 上正在运行的 ${sessions} 个会话不会被结束，` : ''}之后重新添加即可再看到。</p>
    <label className="check"><input id="host-revoke" type="checkbox" checked={revoke && online} disabled={!online} onChange={event => setRevoke(event.target.checked)} />
      <span>同时删除 {host.name} 上 <code>~/.ssh/authorized_keys</code> 中 Tarmac 的公钥（只删与本机公钥一致、带 <code>tarmac-app</code> 标记的那一行）{!online && '；主机未连接，无法删除'}</span></label>
    {error && <p className="rc-error">{error}{revoke && online ? '。可以取消勾选后再移除。' : ''}</p>}
    <div className="rc-actions dialog-actions"><button onClick={onClose}>取消</button>
      <button className="danger" disabled={busy} onClick={remove}>移除</button></div>
  </div></div>;
}

function App(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sessionRef = useRef<DesktopSession | null>(null);
  const metadataRef = useRef<DesktopMetadata | null>(null);
  // Project history per host (LOCAL_HOST or a remote host id).
  const workspacesRef = useRef<Record<string, WorkspaceView>>({});
  const panes = useRef(new Map<string, Pane>());
  const shown = useRef<Pane | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attachStarted = useRef<number | null>(null);
  const attachDuration = useRef<number | undefined>(undefined);
  const switchQueue = useRef<Promise<void>>(Promise.resolve());
  // Hosts whose daemon connection is up; a pane attaches only while its host is.
  const connectedHosts = useRef(new Set<string>());
  const creating = useRef(false);
  const sessionsRef = useRef<DesktopSession[]>([]);
  const knownDirectories = useRef(new Set<string>());
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [hosts, setHosts] = useState<HostView[]>([]);
  const hostsRef = useRef<HostView[]>([]);
  // The shown session another window or machine controls; the notice offers to continue here.
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  const [hostDialog, setHostDialog] = useState<{ mode: 'add' } | { mode: 'edit' | 'remove'; host: HostView } | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(() => {
    try { return localStorage.getItem('tarmac.current-session'); } catch { return null; }
  });
  const currentIdRef = useRef<string | null>(currentId);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [rightVisible, setRightVisible] = useState(false);
  const [rcDismissed, setRcDismissed] = useState(false);
  const [hookCard, setHookCard] = useState<{ provider: HookProvider; stale: boolean } | null>(null);
  // Declined offers stay closed until the App restarts.
  const hookDismissed = useRef(new Set<HookProvider>());
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [workspaces, setWorkspaces] = useState<Record<string, WorkspaceView>>({});
  // A closed current session yields to another alive one; only when every
  // session has ended do we keep the ended entry for the empty state.
  const session = useMemo(() => {
    const current = sessions.find(item => item.sessionId === currentId);
    if (current?.alive) return current;
    return sessions.find(item => item.alive) ?? current ?? sessions[0] ?? null;
  }, [sessions, currentId]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  // Hooks and shell startup files are edited on this machine only.
  const local = hostOf(session) === LOCAL_HOST;
  const sessionHost = local ? undefined : hosts.find(item => item.id === hostOf(session));
  const sessionUp = local ? connected : sessionHost?.state === 'connected';
  const hookProvider = local && session?.alive && (session.foreground?.provider === 'claude' || session.foreground?.provider === 'kimi' || session.foreground?.provider === 'agy')
    ? session.foreground.provider : undefined;
  useEffect(() => {
    if (!hookProvider || hookCard || hookDismissed.current.has(hookProvider)) return;
    let cancelled = false;
    window.tarmac.hooks({ type: 'status', provider: hookProvider }).then(status => {
      if (cancelled || hookDismissed.current.has(hookProvider) || (status.state !== 'missing' && status.state !== 'stale')) return;
      setHookCard(card => card ?? { provider: hookProvider, stale: status.state === 'stale' });
    }, () => {});
    return () => { cancelled = true; };
  }, [hookProvider, hookCard]);
  useEffect(() => {
    if (session && session.sessionId !== currentIdRef.current) select(session.sessionId);
  }, [session]);

  function select(sessionId: string | null): void {
    const changed = currentIdRef.current !== sessionId;
    currentIdRef.current = sessionId;
    sessionRef.current = sessionsRef.current.find(item => item.sessionId === sessionId) ?? null;
    setCurrentId(sessionId);
    if (!changed) return;
    try {
      if (sessionId) localStorage.setItem('tarmac.current-session', sessionId);
      else localStorage.removeItem('tarmac.current-session');
    } catch { setError('无法保存当前会话选择'); }
    show(sessionRef.current);
  }

  // Replaces one host's sessions; the others' stay as they are.
  function applyList(hostId: string, own: DesktopSession[]): void {
    const list = [...sessionsRef.current.filter(item => hostOf(item) !== hostId), ...own];
    sessionsRef.current = list;
    setSessions(list);
    const preferred = currentIdRef.current;
    const next = list.find(item => item.sessionId === preferred && item.alive) ?? list.find(item => item.alive) ?? list.find(item => item.sessionId === preferred) ?? list[0];
    select(next?.sessionId ?? null);
    syncPanes();
  }

  function upsert(value: DesktopSession): void {
    const previous = sessionsRef.current;
    const index = previous.findIndex(item => item.sessionId === value.sessionId);
    const next = [...previous];
    if (index < 0) next.push(value); else next[index] = value;
    sessionsRef.current = next;
    setSessions(next);
    if (currentIdRef.current === value.sessionId) sessionRef.current = value;
    syncPanes();
  }

  function reportAttach(failure: unknown): void { setError(String(failure instanceof Error ? failure.message : failure)); }

  const isShown = (pane: Pane): boolean => shown.current === pane;
  const hostUp = (pane: Pane): boolean => connectedHosts.current.has(splitId(pane.identity.sessionId).host);

  function createTerminal(pane: Pane, cols: number, height: number): StreamTerminal {
    const identity = pane.identity;
    const term = new Terminal({ ...TERMINAL_OPTIONS, cols, rows: height, scrollback: LIMITS.scrollback,
      cursorBlink: !metadataRef.current?.remoteDisplay, disableStdin: true, linkHandler: { activate: () => {} } });
    const guard = suppressTerminalQueries(term.parser);
    term.open(pane.container);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Input typed while a clipboard paste is on its way is held, so it reaches the PTY after it.
    let held: [string, boolean][] | null = null;
    const forward = (data: string, binary: boolean): void => {
      if (held) held.push([data, binary]);
      else void sendInput(data, binary, identity).catch(failure => setError(String(failure)));
    };
    term.onData(data => { if (terminal.current === term && guard.shouldForwardData()) forward(data, false); });
    term.onBinary(data => { if (terminal.current === term) forward(btoa(data), true); });
    term.attachCustomKeyEventHandler(event => {
      if (event.code === 'KeyV' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && isRemote(identity)) {
        // xterm cancels its own Ctrl+V; without this the browser would paste the clipboard text too.
        event.preventDefault();
        if (event.type === 'keydown' && !event.isComposing && terminal.current === term && !held) {
          held = [];
          void clipboardInput(term, identity).then(text => {
            const rest = held ?? [];
            held = null;
            if (text !== null) forward(text, false);
            for (const [data, binary] of rest) forward(data, binary);
          });
        }
        return false;
      }
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey
        && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
        if (terminal.current === term) forward('\x1b[13;2u', false);
        return false;
      }
      return true;
    });
    pane.term = term;
    pane.fit = fitAddon;
    if (isShown(pane)) {
      terminal.current = term;
      fit.current = fitAddon;
      pane.webgl = loadRenderer(term);
    }
    return {
      get cols() { return term.cols; },
      get rows() { return term.rows; },
      write: (data, callback) => term.write(data, callback),
      resize: (nextCols, nextRows) => term.resize(nextCols, nextRows),
      dispose: () => {
        guard.dispose();
        term.dispose();
        if (pane.term === term) { pane.term = null; pane.fit = null; pane.webgl = null; }
        if (terminal.current === term) { terminal.current = null; fit.current = null; }
      },
    };
  }

  // An agent on a remote host reads that host's clipboard, never this one's: Ctrl+V and dropped
  // images go to the session's host first and their saved path is pasted. Without an image in the
  // clipboard, Ctrl+V reaches the agent as before.
  const isRemote = (identity: Identity): boolean => splitId(identity.sessionId).host !== LOCAL_HOST;

  // What Ctrl+V sends: the saved image path (bracketed when the program asked for it), the plain
  // Ctrl+V when the clipboard holds no image, or nothing when the upload failed.
  async function clipboardInput(term: Terminal, identity: Identity): Promise<string | null> {
    try {
      const saved = await window.tarmac.uploadImage(identityOf(identity));
      if (saved === null) return '\x16';
      return term.modes.bracketedPasteMode ? `\x1b[200~${saved}\x1b[201~` : saved;
    } catch (failure) {
      setError(`贴图失败：${failure instanceof Error ? failure.message : String(failure)}`);
      return null;
    }
  }

  async function dropImages(pane: Pane, files: File[]): Promise<void> {
    const images = files.filter(file => file.type.startsWith('image/'));
    if (!images.length) { setError('只能拖入图片'); return; }
    try {
      const saved: string[] = [];
      for (const file of images) {
        if (file.size > UPLOAD_MAX_BYTES) throw new Error(`${file.name} 超过 ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
        const path = await window.tarmac.uploadImage({ ...identityOf(pane.identity), data: new Uint8Array(await file.arrayBuffer()) });
        if (path) saved.push(path);
      }
      if (pane.term && terminal.current === pane.term) pane.term.paste(saved.join(' '));
    } catch (failure) { setError(`贴图失败：${failure instanceof Error ? failure.message : String(failure)}`); }
  }

  function ensurePane(value: SessionInfo): Pane {
    const existing = panes.current.get(value.sessionId);
    if (existing && existing.identity.instanceId === value.instanceId) return existing;
    if (existing) disposePane(existing);
    const container = document.createElement('div');
    container.className = 'terminal-pane';
    if (isRemote(value)) {
      container.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      });
      container.addEventListener('drop', event => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        void dropImages(pane, [...event.dataTransfer.files]);
      });
    }
    host.current!.appendChild(container);
    const pane = { identity: identityOf(value), container, term: null, fit: null, webgl: null,
      attached: false, yielded: false, faults: 0, drops: 0, blocked: false } as Omit<Pane, 'stream'> as Pane;
    pane.stream = new TerminalStream({
      create: (cols, height) => createTerminal(pane, cols, height),
      acknowledge: async (identity: Identity, seq: number, part?: number) => {
        await window.tarmac.request({ type: 'ack', ...identity, seq, ...(part !== undefined ? { part } : {}) });
      },
      ready: ready => paneReady(pane, ready),
      fault: failure => paneFault(pane, failure),
    });
    panes.current.set(value.sessionId, pane);
    return pane;
  }

  function disposePane(pane: Pane): void {
    if (panes.current.get(pane.identity.sessionId) === pane) panes.current.delete(pane.identity.sessionId);
    if (pane.attached && hostUp(pane)) void window.tarmac.request({ type: 'detach', ...pane.identity }).catch(() => {});
    pane.attached = false;
    if (shown.current === pane) shown.current = null;
    pane.stream.dispose();
    pane.container.remove();
  }

  // Only an explicit takeover (force) moves control away from another window or machine; loading
  // a session, shown or in the background, leaves it with whoever is using it.
  async function attachPane(pane: Pane, force = false): Promise<void> {
    if (!hostUp(pane) || pane.attached || pane.blocked || panes.current.get(pane.identity.sessionId) !== pane) return;
    pane.attached = true;
    pane.yielded = false;
    pane.stream.prepare(pane.identity);
    const task = switchQueue.current.then(() => window.tarmac.request({ type: 'attach', ...pane.identity, ...(force ? {} : { ifFree: true }) }));
    switchQueue.current = task.then(() => {}, () => {});
    try { await task; }
    catch (failure) {
      pane.attached = false;
      if (!(failure instanceof Error && failure.message.includes(SESSION_BUSY))) throw failure;
      yieldPane(pane);
      syncPanes();
    }
  }

  // Another connection controls this session; the shown one offers a takeover instead of an error.
  function yieldPane(pane: Pane): void {
    pane.yielded = true;
    if (isShown(pane)) setElsewhere(pane.identity.sessionId);
  }

  // Background failures stay quiet; the displayed session reports its own.
  const attachQuietly = (pane: Pane): void => { void attachPane(pane).catch(failure => { if (isShown(pane)) reportAttach(failure); }); };

  // Keeps one pane per live session. The displayed session replays first, then background ones
  // one at a time: they do not compete with it after a reconnect, and a lost connection can be
  // attributed to the single session that was replaying.
  function syncPanes(): void {
    const alive = sessionsRef.current.filter(item => item.alive);
    for (const pane of [...panes.current.values()]) {
      if (!alive.some(item => item.sessionId === pane.identity.sessionId && item.instanceId === pane.identity.instanceId)) disposePane(pane);
    }
    if (!host.current) return;
    const waiting = (pane: Pane): boolean => hostUp(pane) && !pane.attached && !pane.yielded && !pane.blocked;
    const replaying = (pane: Pane): boolean => pane.attached && !pane.stream.acceptsInput();
    const current = alive.find(item => item.sessionId === currentIdRef.current);
    const front = current ? ensurePane(current) : undefined;
    if (front && waiting(front)) attachQuietly(front);
    const background = alive.filter(item => item !== current).map(ensurePane);
    if ((front && replaying(front)) || background.some(replaying)) return;
    const next = background.find(waiting);
    if (next) attachQuietly(next);
  }

  function show(value: SessionInfo | null): void {
    const pane = value?.alive && host.current ? ensurePane(value) : null;
    const previous = shown.current;
    if (previous && previous !== pane) {
      previous.container.classList.remove('visible');
      previous.webgl?.dispose();
      previous.webgl = null;
    }
    shown.current = pane;
    terminal.current = pane?.term ?? null;
    fit.current = pane?.fit ?? null;
    if (!pane) return;
    pane.container.classList.add('visible');
    if (pane.term && !pane.webgl) pane.webgl = loadRenderer(pane.term);
    if (previous !== pane) {
      attachDuration.current = undefined;
      attachStarted.current = metadataRef.current?.smoke ? performance.now() : null;
    }
    if (pane.stream.acceptsInput()) shownReady();
    else if (pane.blocked) setError('该会话的终端数据多次恢复失败，已停止自动连接；点击左侧该会话可重试');
    else if (!pane.attached) {
      // Showing tries again without taking over; the notice appears only if it is still in use elsewhere.
      if (!pane.yielded) setElsewhere(null);
      attachQuietly(pane);
    }
  }

  function shownReady(): void {
    setElsewhere(null);
    if (attachStarted.current !== null) {
      attachDuration.current = performance.now() - attachStarted.current;
      attachStarted.current = null;
    }
    terminal.current?.focus();
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(resizeToHost, 0);
    syncPanes();
  }

  function paneReady(pane: Pane, ready: boolean): void {
    if (pane.term) pane.term.options.disableStdin = !ready;
    if (!ready) return;
    pane.faults = 0;
    pane.drops = 0;
    if (isShown(pane)) shownReady();
    else syncPanes();
  }

  function paneFault(pane: Pane, failure: Error): void {
    pane.attached = false;
    const value = sessionsRef.current.find(item => item.sessionId === pane.identity.sessionId && item.instanceId === pane.identity.instanceId);
    // A broken stream is rebuilt from the replay log; repeated faults stay visible.
    if (value?.alive && ++pane.faults <= PANE_RETRIES) {
      if (isShown(pane)) setError(`${failure.message}，正在重新同步`);
      setTimeout(() => attachQuietly(pane), 300);
      return;
    }
    pane.blocked = true;
    if (isShown(pane)) setError(`${failure.message}；已停止自动连接，点击左侧该会话可重试`);
    syncPanes();
  }

  async function refresh(hostId = LOCAL_HOST): Promise<void> {
    applyList(hostId, await window.tarmac.request<DesktopSession[]>({ type: 'list', ...(hostId === LOCAL_HOST ? {} : { host: hostId }) }));
  }

  async function create(options: CreateOptions, hostId = LOCAL_HOST): Promise<void> {
    if (creating.current) return;
    creating.current = true;
    const remote = hostId === LOCAL_HOST ? {} : { host: hostId };
    try {
      const value = await window.tarmac.request<DesktopSession>({ type: 'create', options, ...remote });
      setError('');
      upsert(value);
      select(value.sessionId);
      await window.tarmac.workspace({ type: 'touch', path: options.cwd, ...remote }).catch(() => {});
    } finally { creating.current = false; }
  }

  // A remote host's Shell is the one its bridge reported; this machine's comes from metadata.
  function newShell(cwd: string, hostId = LOCAL_HOST): void {
    const remote = hostId === LOCAL_HOST ? undefined : hostsRef.current.find(item => item.id === hostId);
    if (hostId !== LOCAL_HOST && (!remote?.shell || !connectedHosts.current.has(hostId))) {
      setError(`${remote?.name ?? '远程主机'}未连接，重连后才能新建`);
      return;
    }
    const center = host.current;
    const cols = Math.max(2, Math.min(500, Math.floor((center?.clientWidth ?? 800) / CELL.width)));
    const height = Math.max(1, Math.min(200, Math.floor((center?.clientHeight ?? 600) / CELL.height)));
    const shell = remote?.shell ?? { command: metadataRef.current?.shell ?? '/bin/sh', args: metadataRef.current?.shellArgs ?? ['-l'] };
    void create({ command: shell.command, args: shell.args, cwd, cols, rows: height }, hostId)
      .catch(failure => setError(String(failure instanceof Error ? failure.message : failure)));
  }

  function openProject(hostId: string, dir: string): void {
    const entry = workspacesRef.current[hostId]?.projects.find(project => project.path === dir);
    if (entry && !entry.exists) { setError(`目录不存在：${dir}`); return; }
    newShell(dir, hostId);
  }

  function clearRecent(hostId: string): void {
    // Open directories stay in the store; they are not shown as history while open.
    const keep = sessionsRef.current.filter(item => item.alive && hostOf(item) === hostId).map(liveDir);
    void window.tarmac.workspace({ type: 'clear', keep, ...(hostId === LOCAL_HOST ? {} : { host: hostId }) }).then(() => {
      const prefix = hostKey(hostId, '');
      for (const key of [...knownDirectories.current]) if (key.startsWith(prefix) && !keep.includes(key.slice(prefix.length))) knownDirectories.current.delete(key);
      const view = workspacesRef.current[hostId];
      if (view) {
        workspacesRef.current = { ...workspacesRef.current, [hostId]: { ...view, projects: view.projects.filter(project => keep.includes(project.path)) } };
        setWorkspaces(workspacesRef.current);
      }
    }, failure => setError(ipcError(failure)));
  }

  // New Shells follow the current session: same host, same directory.
  function currentHost(): string {
    const value = sessionRef.current;
    return value?.alive ? hostOf(value) : LOCAL_HOST;
  }
  function currentDir(): string {
    const value = sessionRef.current;
    if (value?.alive) return value.foreground?.cwd ?? value.cwd;
    return metadataRef.current?.cwd ?? '/';
  }
  const newHere = (): void => newShell(currentDir(), currentHost());

  async function sendInput(data: string, binary = false, expected?: Identity): Promise<void> {
    const value = sessionRef.current;
    if (!value?.alive || !shown.current?.stream.acceptsInput()) return;
    if (expected && (expected.sessionId !== value.sessionId || expected.instanceId !== value.instanceId)) return;
    await window.tarmac.request({ type: 'input', ...identityOf(value), data, binary });
  }

  function resizeToHost(): void {
    const value = sessionRef.current;
    if (!value?.alive || !shown.current?.stream.acceptsInput() || !fit.current) return;
    const dimensions = fit.current.proposeDimensions();
    if (!dimensions || dimensions.cols < 2 || dimensions.rows < 1) return;
    const cols = Math.min(500, dimensions.cols);
    const height = Math.min(200, dimensions.rows);
    if (terminal.current?.cols === cols && terminal.current?.rows === height) return;
    // Resize is applied locally only when its sequenced server event arrives.
    void window.tarmac.request({ type: 'resize', ...identityOf(value), cols, rows: height }).catch(failure => setError(String(failure)));
  }

  // Project history and branch of the live session's directory.
  // The TUI shows a placeholder instead of a finished session.
  useEffect(() => { show(session?.alive ? session : null); }, [session?.sessionId, session?.instanceId, session?.alive]);

  // A live directory moves to the front of its host's history, as in the TUI.
  const currentCwd = session?.alive ? liveDir(session) : undefined;
  const currentHostId = hostOf(session);
  useEffect(() => {
    if (!currentCwd) return;
    void window.tarmac.workspace({ type: 'touch', path: currentCwd, ...(currentHostId === LOCAL_HOST ? {} : { host: currentHostId }) })
      .catch(failure => setError(String(failure instanceof Error ? failure.message : failure)));
  }, [currentCwd, currentHostId]);

  // Project history of every host and the branch of every open directory.
  const openDirectories = [...new Set(sessions.filter(item => item.alive).map(item => hostKey(hostOf(item), liveDir(item))))].sort().join('\n');
  const hostIds = [LOCAL_HOST, ...hosts.map(item => item.id)].join('\n');
  useEffect(() => {
    let disposed = false;
    const remote = (id: string) => id === LOCAL_HOST ? {} : { host: id };
    const entries = openDirectories ? openDirectories.split('\n').map(key => {
      const index = key.indexOf('\0');
      return { key, host: key.slice(0, index), dir: key.slice(index + 1) };
    }) : [];
    const load = async (): Promise<void> => {
      // A remote host's failure must not hide this machine's history.
      const views = await Promise.all(hostIds.split('\n').map(async id => [id, await window.tarmac.workspace({ type: 'view', ...remote(id) })
        .catch(failure => { if (id === LOCAL_HOST) throw failure; return null; })] as const));
      const values = await Promise.all(entries.map(async entry => {
        const view = await window.tarmac.workspace({ type: 'view', current: entry.dir, ...remote(entry.host) })
          .catch(failure => { if (entry.host === LOCAL_HOST) throw failure; return null; });
        return [entry.key, view?.branch ?? ''] as const;
      }));
      if (disposed) return;
      workspacesRef.current = Object.fromEntries(views.filter((item): item is readonly [string, WorkspaceView] => item[1] !== null));
      setWorkspaces(workspacesRef.current);
      setBranches(Object.fromEntries(values));
    };
    void (async () => {
      for (const entry of entries) {
        if (knownDirectories.current.has(entry.key)) continue;
        await window.tarmac.workspace({ type: 'touch', path: entry.dir, ...remote(entry.host) });
        knownDirectories.current.add(entry.key);
      }
      await load();
    })().catch(reportAttach);
    const timer = setInterval(() => { void load().catch(reportAttach); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [openDirectories, hostIds]);

  useEffect(() => {
    const value = session;
    const seq = value?.history.records.at(-1)?.seq;
    if (!sessionUp || !rightVisible || !value || seq === undefined || seq <= value.history.readSeq) return;
    void window.tarmac.request({ type: 'read', ...identityOf(value), seq }).catch(reportAttach);
  }, [sessionUp, rightVisible, session?.sessionId, session?.history.records.at(-1)?.seq, session?.history.readSeq]);

  // Window shortcuts are consumed before xterm encodes them for the PTY.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.isComposing) return;
      if (event.code !== 'KeyN' && event.code !== 'KeyH') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.code === 'KeyN') newHere();
      else setRightVisible(value => !value);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    let disposed = false;
    const onEvent = (event: DesktopEvent): void => {
      if (disposed) return;
      if (event.type === 'connection') {
        const id = event.host;
        if (event.connected) connectedHosts.current.add(id); else connectedHosts.current.delete(id);
        if (id === LOCAL_HOST) setConnected(event.connected);
        if (event.removed) { applyList(id, []); return; }
        if (event.connected) {
          if (id === LOCAL_HOST) setError('');
          void refresh(id).catch(failure => setError(String(failure)));
        } else {
          // Only this host's panes lose their stream; a remote host's sessions keep their last state.
          for (const pane of panes.current.values()) {
            if (splitId(pane.identity.sessionId).host !== id) continue;
            if (pane.attached && !pane.stream.acceptsInput() && ++pane.drops >= PANE_RETRIES) pane.blocked = true;
            pane.attached = false;
            pane.stream.disconnect();
          }
          // A remote host reports its own errors in its sidebar section.
          if (event.error && id === LOCAL_HOST) setError(event.error);
        }
      } else if (event.type === 'hosts') {
        hostsRef.current = event.hosts;
        setHosts(event.hosts);
      } else if (event.type === 'info') {
        upsert(event.session);
      } else if (event.type === 'resync') {
        const pane = panes.current.get(event.sessionId);
        if (!pane || pane.identity.instanceId !== event.instanceId || !pane.attached) return;
        pane.attached = false;
        pane.stream.disconnect();
        // Taking control back automatically would make two windows fight over every session.
        if (event.reason.includes('control transferred')) yieldPane(pane);
        else {
          if (isShown(pane)) setError(event.reason);
          attachQuietly(pane);
        }
      } else void panes.current.get(event.sessionId)?.stream.receive(event);
    };
    const unsubscribe = window.tarmac.subscribe(onEvent);
    void window.tarmac.ready().then(metadata => {
      if (disposed) return;
      metadataRef.current = metadata;
      document.documentElement.dataset.platform = metadata.platform;
      if (metadata.connected) connectedHosts.current.add(LOCAL_HOST);
      setConnected(metadata.connected);
      if (metadata.connected) void refresh().catch(failure => setError(String(failure)));
      void window.tarmac.hosts({ type: 'list' }).then(list => {
        if (disposed) return;
        hostsRef.current = list;
        setHosts(list);
        for (const item of list) {
          if (item.state !== 'connected' || connectedHosts.current.has(item.id)) continue;
          connectedHosts.current.add(item.id);
          void refresh(item.id).catch(() => {});
        }
      }).catch(failure => setError(String(failure)));
      if (metadata.smoke) window.tarmacSmoke = {
        start: async () => {
          const deadline = Date.now() + 10_000;
          for (;;) {
            try { await window.tarmac.request({ type: 'list' }); break; }
            catch (failure) { if (Date.now() >= deadline) throw failure; await new Promise(resolve => setTimeout(resolve, 50)); }
          }
          await create({ command: '/bin/sh', args: ['-c', 'printf "\\033[32mM0-DESKTOP-READY\\033[0m\\r\\n"; read value; printf "M0-INPUT:%s\\r\\n" "$value"; stty -icanon -echo; printf "M0-CONTROLS-READY\\r\\n"; dd bs=1 count=2 2>/dev/null | od -An -tx1; sleep 30'], cwd: metadata.cwd, cols: 100, rows: 30 });
        },
        state: () => {
          const term = terminal.current;
          const lines: string[] = [];
          let nativeGreen = false;
          if (term) for (let i = 0; i < term.buffer.active.length; i++) {
            const line = term.buffer.active.getLine(i);
            lines.push(line?.translateToString(true) ?? '');
            const cell = line?.getCell(0);
            if (cell?.getChars() === 'M' && cell.isFgPalette() && cell.getFgColor() === 2) nativeGreen = true;
          }
          const value = sessionRef.current;
          return { text: lines.join('\n'), nativeGreen, ready: shown.current?.stream.acceptsInput() ?? false, sessionId: value?.sessionId, instanceId: value?.instanceId, pid: value?.pid, attachMs: attachDuration.current,
            error: document.querySelector('.side .error')?.textContent ?? undefined };
        },
      };
    }).catch(failure => setError(String(failure)));
    const observer = new ResizeObserver(() => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(resizeToHost, 75);
    });
    if (host.current) observer.observe(host.current);
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      for (const pane of [...panes.current.values()]) disposePane(pane);
      delete window.tarmacSmoke;
    };
  }, []);

  const projects = Object.fromEntries(Object.entries(workspaces).map(([id, view]) => [id, view.projects.map(project => project.path)]));
  const sections = hostSections(sessions, session?.sessionId ?? null, branches, projects, collapsed, hosts);
  const offline = !local && Boolean(session?.alive) && !sessionUp;
  const controlledElsewhere = !offline && Boolean(session?.alive) && elsewhere === session?.sessionId;
  const takeOver = (): void => {
    const pane = shown.current;
    if (!pane) return;
    pane.yielded = false;
    void attachPane(pane, true).catch(reportAttach);
  };
  const takeover = local && session?.alive && session.shellTakeover === 'tmux' && !rcDismissed;
  const history = historyModel(session);
  if (sessionHost) history.diagnostics.unshift(['主机', `${sessionHost.name}（${hostAddress(sessionHost)}）`]);
  const hostAction = (id: string, action: HostAction): void => {
    if (id === LOCAL_HOST) { if (action === 'new') newShell(metadataRef.current?.cwd ?? '/'); return; }
    const target = hostsRef.current.find(item => item.id === id);
    if (!target) return;
    if (action === 'new') newShell(target.home ?? '/', id);
    else if (action === 'edit' || action === 'remove') setHostDialog({ mode: action, host: target });
    else void window.tarmac.hosts({ type: action, id }).catch(failure => setError(ipcError(failure)));
  };
  return <div className="desktop">
    <Titlebar session={session} host={sessionHost} offline={offline} />
    <div className={rightVisible ? 'app with-history' : 'app'}>
    <Sidebar sections={sections} hosts={hosts} error={error || (!connected ? '会话服务连接中…' : '')}
      onSession={id => {
        // Clicking is the explicit retry for a session that stopped reconnecting.
        const pane = panes.current.get(id);
        if (pane?.blocked) { pane.blocked = false; pane.faults = 0; pane.drops = 0; setError(''); }
        select(id); show(sessionsRef.current.find(item => item.sessionId === id) ?? null); terminal.current?.focus();
      }}
      onToggle={(hostId, path) => setCollapsed(previous => {
        const key = hostKey(hostId, path);
        const next = new Set(previous);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      })} onProject={openProject} onClearRecent={clearRecent}
      onHistory={() => setRightVisible(value => !value)} onNew={newHere}
      onAddHost={() => setHostDialog({ mode: 'add' })} onHostAction={hostAction} />
    <main className="center" aria-label="会话终端">
      <div ref={host} className={offline || controlledElsewhere ? 'terminal-host offline' : 'terminal-host'} />
      {controlledElsewhere && <div className="empty remote-offline elsewhere"><strong>这个会话正在另一个 Tarmac 窗口中操作</strong>
        <span>可能在另一台电脑上。为避免两边同时输入，这里先不接管；接管后另一边会停在当前画面，那边点击会话可以再接管回去。</span>
        <div className="rc-actions"><button className="primary" onClick={takeOver}>在这里继续</button></div></div>}
      {takeover && <ShellTakeover onNew={newHere} onDismiss={() => setRcDismissed(true)} />}
      {local && hookCard && !takeover
        && <HooksCard key={hookCard.provider} provider={hookCard.provider} stale={hookCard.stale}
          onClose={() => { hookDismissed.current.add(hookCard.provider); setHookCard(null); }} />}
      {offline && sessionHost && <div className="empty remote-offline"><strong>与 {sessionHost.name} 的连接已断开</strong>
        <span>这个会话的 agent 仍在 {sessionHost.name} 上运行。{sessionHost.state === 'stopped' ? '' : '正在自动重连，'}连上后恢复当前画面；断开期间无法输入。</span>
        <div className="rc-actions"><button className="primary" onClick={() => hostAction(sessionHost.id, 'reconnect')}>立即重连</button></div></div>}
      {!session?.alive && <div className="empty"><strong>暂无 agent</strong><span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd> 新建 Shell，或点击左侧历史项目</span></div>}
    </main>
    {rightVisible && <History model={history} onClose={() => setRightVisible(false)} />}
    </div>
    {hostDialog?.mode === 'add' && <HostDialog onClose={() => setHostDialog(null)} />}
    {hostDialog?.mode === 'edit' && <HostDialog host={hostDialog.host} onClose={() => setHostDialog(null)} />}
    {hostDialog?.mode === 'remove' && <RemoveHostDialog host={hostDialog.host}
      sessions={sessions.filter(item => item.alive && hostOf(item) === hostDialog.host.id).length} onClose={() => setHostDialog(null)} />}
  </div>;
}

// xterm measures its cell once, from whatever font is ready when a terminal opens, so the bundled
// fonts load first. A font that fails to load must not keep the App from starting.
const fontsReady = Promise.all(['16px "Ubuntu Sans Mono"', 'italic 16px "Ubuntu Sans Mono"', '13px "Ubuntu"']
  .map(font => document.fonts.load(font)).concat(document.fonts.load('16px "MiSans"', '中')));
void Promise.race([fontsReady, new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {})
  .then(() => createRoot(document.getElementById('root')!).render(<App />));
