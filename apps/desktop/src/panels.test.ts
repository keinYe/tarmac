import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_HINT, baseName, formatClock, formatRate, formatTime, historyModel, hostKey, hostSections, hostStatus, sessionRow, sidebarModel, systemModel, tokenUsageModel } from './panels.ts';
import type { SessionInfo, SystemSample } from '../../../packages/protocol/src/index.ts';

const info = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's', instanceId: 'i', pid: 42, command: '/bin/zsh', args: ['-l'], cwd: '/p/start', cols: 80, rows: 24, alive: true,
  foreground: { pid: 43, name: 'codex', cwd: '/p/my-app', provider: 'codex' }, agent: null,
  hooks: { configured: false, verified: false },
  history: { records: [{ eventId: 'e', provider: 'codex', agentSessionId: 'a', seq: 1, at: '2026-11-13T12:05:00Z', prompt: '\n  first line\nsecond' }], readSeq: 0, unread: 2 },
  ...extra,
});

test('session row follows the TUI: foreground brand, degraded state, last input first line, unread', () => {
  assert.deepEqual(sessionRow(info()), { brand: 'codex', name: 'Codex', activity: 'running', preview: 'first line', hint: false, unread: 2 });
  const approval = sessionRow(info({ agent: { provider: 'codex', agentSessionId: 'a', agentRunId: 'r', activity: 'permission', pendingTools: [] } }));
  assert.deepEqual([approval.activity, approval.preview, approval.hint], ['permission', APPROVAL_HINT, true]);
  const shell = sessionRow(info({ foreground: { pid: 42, name: 'zsh', cwd: '/p/my-app' } }));
  assert.deepEqual([shell.brand, shell.activity], ['shell', undefined], 'a shell without an agent shows no state');
  assert.equal(sessionRow(info({ history: { records: [], readSeq: 0, unread: 0 } })).preview, '');
});

test('Kimi and Antigravity have their own identities without borrowing another agent state or usage', () => {
  for (const [provider, name] of [['kimi', 'Kimi'], ['agy', 'Antigravity']] as const) {
    const current = info({ foreground: { pid: 44, name: provider, provider, cwd: '/p' },
      agent: { provider: 'codex', agentSessionId: 'old', agentRunId: '43', activity: 'permission', pendingTools: [] } });
    assert.deepEqual(sessionRow(current), { brand: provider, name, activity: 'running', preview: '', hint: false, unread: 0 });
    assert.equal(tokenUsageModel(current), null);
    assert.deepEqual(historyModel(current).records, []);
    assert.ok(historyModel(current).notes.includes('输入记录尚未接入'));
    assert.ok(historyModel(current).diagnostics.some(([key, value]) => key === 'hooks' && value === '未配置'));
  }
});

test('Antigravity hook state and input history are visible when active', () => {
  const current = info({ foreground: { pid: 44, name: 'agy', provider: 'agy', cwd: '/p' },
    agent: { provider: 'agy', agentSessionId: 'agy-s1', agentRunId: '44', activity: 'working', pendingTools: [] },
    hooks: { configured: true, verified: true },
    history: { records: [{ eventId: 'e1', provider: 'agy', agentSessionId: 'agy-s1', seq: 1, at: '2026-11-19T12:00:00Z', prompt: 'test agy prompt' }], readSeq: 0, unread: 1 } });
  assert.equal(sessionRow(current).activity, 'working');
  assert.equal(sessionRow(current).preview, 'test agy prompt');
  assert.equal(sessionRow(current).unread, 1);
  assert.deepEqual(historyModel(current).records, [{ id: 'e1', time: formatTime('2026-11-19T12:00:00Z'), text: 'test agy prompt' }]);
  assert.ok(historyModel(current).diagnostics.some(([key, value]) => key === 'hooks' && value === '已验证'));
  assert.equal(tokenUsageModel(current), null);
  const counted = info({ ...current, usage: { provider: 'agy', agentSessionId: 'agy-s1', agentRunId: '44', inputTokens: 15899,
    outputTokens: 255, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 16154 } });
  assert.equal(tokenUsageModel(counted)?.label, 'Token 16.2K');
  assert.deepEqual(tokenUsageModel(counted)?.windows, []);
});

test('Codex profiles change the displayed name while retaining Codex brand and usage ownership', () => {
  for (const profile of ['deepseek', 'ark', 'custom-work']) {
    const current = info({ foreground: { pid: 43, name: 'codex', provider: 'codex', profile, cwd: '/p' } });
    assert.equal(sessionRow(current).brand, 'codex');
    assert.equal(sessionRow(current).name, `Codex · ${profile}`);
  }
});

test('Kimi hook state and token totals are visible; partial Codex counts are labeled explicitly', () => {
  const current = info({ foreground: { pid: 43, name: 'kimi-code', provider: 'kimi', cwd: '/p' },
    agent: { provider: 'kimi', agentSessionId: 'a', agentRunId: '43', activity: 'waiting', pendingTools: [] },
    usage: { provider: 'kimi', agentSessionId: 'a', agentRunId: '43', inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 80, cacheWriteTokens: 0, totalTokens: 120 } });
  assert.equal(sessionRow(current).activity, 'waiting');
  assert.equal(tokenUsageModel(current)?.label, 'Token 120');
  const partial = info({ usage: { ...current.usage!, provider: 'codex', scope: 'observed' } });
  assert.equal(tokenUsageModel(partial)?.label, 'Token 120（接入后）');
  assert.match(tokenUsageModel(partial)?.detail ?? '', /不含历史与缺失事件/);
});

test('Kimi account quota shows its named month window and says it came from the account endpoint', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const current = info({ foreground: { pid: 43, name: 'kimi-code', provider: 'kimi', cwd: '/p' },
    agent: { provider: 'kimi', agentSessionId: 'a', agentRunId: '43', activity: 'waiting', pendingTools: [] },
    usage: { provider: 'kimi', agentSessionId: 'a', agentRunId: '43', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0,
      cacheWriteTokens: 0, totalTokens: 120, rateLimits: { observedAt: new Date(now).toISOString(), source: 'account', windows: [
        { windowMinutes: 300, usedPercent: 7, resetsAt: now / 1000 + 3600 },
        { windowMinutes: 0, period: '月', usedPercent: 33, resetsAt: now / 1000 + 11 * 86400 },
        // A zero-length window without a name is not displayed.
        { windowMinutes: 0, usedPercent: 50, resetsAt: now / 1000 + 3600 },
      ] } } });
  const model = tokenUsageModel(current, now)!;
  assert.equal(model.limits, '5h 已用 7% · 1h0m ｜ 月 已用 33% · 11d0h');
  assert.match(model.limitsDetail!, /^账户配额（来自账户接口）/);
  assert.match(model.limitsDetail!, /月 已用 33%：/);
});

test('a Claude quota from another session of the same account says so', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const current = info({ foreground: { pid: 42, name: 'claude', provider: 'claude', cwd: '/p' },
    agent: { provider: 'claude', agentSessionId: 'a', agentRunId: '42', activity: 'waiting', pendingTools: [] },
    usage: { provider: 'claude', agentSessionId: 'a', agentRunId: '42', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0,
      cacheWriteTokens: 0, totalTokens: 120, rateLimits: { observedAt: new Date(now).toISOString(), source: 'shared',
        windows: [{ windowMinutes: 300, usedPercent: 54, resetsAt: now / 1000 + 3600 }] } } });
  const model = tokenUsageModel(current, now)!;
  assert.equal(model.limits, '5h 已用 54% · 1h0m');
  assert.match(model.limitsDetail!, /^账户配额（同一账户其他会话记录的快照）/);
});

test('sidebar groups live sessions by current directory and excludes all open projects from history', () => {
  const projects = ['/p/my-app', ...Array.from({ length: 12 }, (_, i) => `/p/project-${i}/`)];
  const live = sidebarModel([info()], 's', { '/p/my-app': 'app-architecture' }, projects, new Set());
  assert.deepEqual(live.groups[0] && { path: live.groups[0].path, name: live.groups[0].name, branch: live.groups[0].branch }, { path: '/p/my-app', name: 'my-app', branch: 'app-architecture' });
  assert.equal(live.count, 1);
  assert.equal(live.recent.length, 10);
  assert.ok(!live.recent.some(project => project.path === '/p/my-app'), 'the live directory is not repeated as history');
  assert.equal(live.recent[0].name, 'project-0');
  const exited = sidebarModel([info({ alive: false })], 's', {}, projects, new Set());
  assert.deepEqual(exited.groups, [], 'finished sessions are not listed, as in the TUI');
  assert.equal(exited.count, 0);
  assert.equal(exited.recent[0].path, '/p/my-app');
  assert.equal(sidebarModel([], null, {}, [], new Set()).recent.length, 0);
  const parallel = sidebarModel([info(), info({ sessionId: 'b' }), info({ sessionId: 'c',
    foreground: { pid: 45, name: 'kimi', provider: 'kimi', cwd: '/p/other' } })], 'b',
    { '/p/my-app': 'main', '/p/other': 'feature' }, ['/p/other', '/p/my-app', '/p/old'], new Set(['/p/other']));
  assert.equal(parallel.count, 3);
  assert.deepEqual(parallel.groups.map(group => [group.path, group.branch, group.sessions.length, group.collapsed]),
    [['/p/my-app', 'main', 2, false], ['/p/other', 'feature', 1, true]]);
  assert.deepEqual(parallel.groups[0].sessions.map(row => [row.sessionId, row.active]), [['s', false], ['b', true]]);
  assert.deepEqual(parallel.recent.map(project => project.path), ['/p/old']);
});

test('history panel lists input records and diagnostics including degraded restoration', () => {
  const model = historyModel(info({ replay: { exact: false, reason: '日志达到上限' }, hooks: { configured: true, verified: false, configError: 'Invalid JSON' } }));
  assert.match(model.records[0].time, /^\d\d:05$/);
  assert.equal(model.records[0].text, 'first line\nsecond');
  assert.deepEqual(model.diagnostics, [['状态', '运行中 · PID 42'], ['hooks', '待验证'], ['恢复', '降级']]);
  assert.deepEqual(model.alerts, ['画面恢复降级：日志达到上限', '配置检测：Invalid JSON']);
  assert.ok(model.notes.includes('输入记录尚未接入'));
  assert.deepEqual(historyModel(null).diagnostics, [['状态', '无运行中的会话']]);
  assert.equal(historyModel(info({ alive: false, exitCode: 127 })).diagnostics[0][1], '已退出（127） · PID 42');
});

test('titlebar token label is compact with exact counts including cache in its tooltip', () => {
  const usage = { provider: 'codex' as const, agentSessionId: 'a', agentRunId: '43',
    inputTokens: 1200000, outputTokens: 34567, cacheReadTokens: 800000, cacheWriteTokens: 0, totalTokens: 1234567 };
  const model = tokenUsageModel(info({ usage }));
  assert.equal(model?.label, 'Token 1.2M');
  assert.match(model!.detail, /1,234,567 tokens/);
  assert.match(model!.detail, /输入（含缓存）：1,200,000/);
  assert.match(model!.detail, /缓存读取：800,000/);
  assert.equal(tokenUsageModel(info({ usage: { ...usage, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }))?.label, 'Token 0');
});

test('titlebar never displays another process, provider or conversation usage', () => {
  const usage = { provider: 'codex' as const, agentSessionId: 'a', agentRunId: '43',
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110 };
  for (const changed of [{ agentRunId: 'old' }, { provider: 'claude' as const }, { totalTokens: NaN }]) {
    assert.equal(tokenUsageModel(info({ usage: { ...usage, ...changed } })), null);
  }
  assert.equal(tokenUsageModel(info({ usage, agent: { provider: 'codex', agentSessionId: 'other', agentRunId: '43', activity: 'working', pendingTools: [] } })), null);
  assert.equal(tokenUsageModel(info({ usage, alive: false })), null);
  assert.equal(tokenUsageModel(info({ usage, foreground: { pid: 42, name: 'zsh', cwd: '/p' } })), null);
  assert.equal(tokenUsageModel(null), null);
  assert.equal(tokenUsageModel(info({ usageError: '暂时无法读取当前会话用量' })), null);
  assert.equal(tokenUsageModel(info()), null, 'unassociated shared-daemon Codex usage is hidden');
  assert.equal(tokenUsageModel(info({ foreground: { pid: 43, name: 'claude', cwd: '/p', provider: 'claude' },
    usageError: '暂时无法读取当前会话用量' }))?.detail, '暂时无法读取当前会话用量');
});

test('titlebar quota countdown follows window length, ticks and marks expired snapshots', () => {
  const now = Date.parse('2026-11-15T01:00:00Z');
  const usage = { provider: 'codex' as const, agentSessionId: 'a', agentRunId: '43',
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, totalTokens: 1200,
    rateLimits: { observedAt: new Date(now).toISOString(), windows: [
      { windowMinutes: 10080, usedPercent: 7, resetsAt: now / 1000 + 7 * 86400 },
      { windowMinutes: 300, usedPercent: 37, resetsAt: now / 1000 + 4 * 3600 + 18 * 60 },
    ] } };
  const model = tokenUsageModel(info({ usage }), now)!;
  assert.match(model.limits!, /7d 已用 7% · 7d0h/);
  assert.match(model.limits!, /5h 已用 37% · 4h18m/);
  assert.match(model.limitsDetail!, /账户配额/);
  assert.match(tokenUsageModel(info({ usage }), now + 60000)!.limits!, /4h17m/);
  assert.match(tokenUsageModel(info({ usage }), now + 8 * 86400000)!.limits!, /待更新/);
  assert.equal(tokenUsageModel(info({ usage: { ...usage, rateLimits: undefined } }), now)!.limits, '配额 · 暂无数据');
  assert.equal(tokenUsageModel(info({ usage: { ...usage, agentRunId: 'old' } }), now), null);
  const claude = info({ foreground: { pid: 43, name: 'claude', cwd: '/p', provider: 'claude' }, usage: { ...usage, provider: 'claude' } });
  assert.match(tokenUsageModel(claude, now)!.limits!, /5h 已用 37%/);
});

test('quota duration is compact and percentage colors change at terminal warning thresholds', () => {
  const now = Date.parse('2026-11-15T01:00:00Z');
  const usage = { provider: 'codex' as const, agentSessionId: 'a', agentRunId: '43', inputTokens: 100, outputTokens: 10,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110, rateLimits: { observedAt: new Date(now).toISOString(), windows: [
      { windowMinutes: 10080, usedPercent: 49, resetsAt: now / 1000 + 2 * 86400 + 3 * 3600 + 15 * 60 },
      { windowMinutes: 300, usedPercent: 50, resetsAt: now / 1000 + 1 },
      { windowMinutes: 60, usedPercent: 80, resetsAt: now / 1000 },
    ] } };
  const model = tokenUsageModel(info({ usage }), now)!;
  assert.equal(model.available, true);
  assert.deepEqual(model.windows?.map(window => [window.reset, window.tone]), [['2d3h', 'ok'], ['1m', 'warn'], ['待更新', 'danger']]);
});

test('directory names split Windows paths on both separators but keep POSIX backslashes', () => {
  assert.equal(baseName('/home/me/repo/'), 'repo');
  assert.equal(baseName('/'), '/');
  assert.equal(baseName('/home/me/a\\b'), 'a\\b');
  assert.equal(baseName('C:\\Users\\me\\repo\\'), 'repo');
  assert.equal(baseName('D:/work/项目'), '项目');
  assert.equal(baseName('\\\\server\\share\\repo'), 'repo');
  assert.equal(baseName('C:\\'), 'C:');
});

test('remote hosts come first with their own groups, history and branches; this machine is last', () => {
  const remote = { ...info({ sessionId: 'h1:s2', cwd: '/home/dev/my-app', foreground: { pid: 7, name: 'claude', cwd: '/home/dev/my-app', provider: 'claude' } }), host: 'h1' };
  const local = info({ sessionId: 's1', foreground: { pid: 8, name: 'zsh', cwd: 'C:\\work' } });
  const sections = hostSections([local, remote], 'h1:s2', { [hostKey('h1', '/home/dev/my-app')]: 'main', [hostKey('local', 'C:\\work')]: 'dev' },
    { h1: ['/home/dev/blog', '/home/dev/my-app'], local: ['C:\\notes'] }, new Set([hostKey('local', 'C:\\work')]),
    [{ id: 'h1', name: 'ws', address: '192.168.1.20', state: 'connected' }]);
  assert.deepEqual(sections.map(section => [section.id, section.offline]), [['h1', false], ['local', false]]);
  assert.deepEqual(sections[0].model.groups.map(group => [group.path, group.branch, group.collapsed, group.sessions[0].active]), [['/home/dev/my-app', 'main', false, true]]);
  assert.deepEqual(sections[0].model.recent.map(project => project.path), ['/home/dev/blog'], 'an open directory is not repeated as history');
  assert.deepEqual(sections[1].model.groups.map(group => [group.path, group.branch, group.collapsed]), [['C:\\work', 'dev', true]]);
  assert.deepEqual(sections[1].model.recent.map(project => project.path), ['C:\\notes']);
  const offline = hostSections([remote], null, {}, {}, new Set(), [{ id: 'h1', name: 'ws', state: 'waiting', retryAt: 10_500 }]);
  assert.equal(offline[0].offline, true);
  assert.equal(offline[0].model.count, 1, 'a disconnected host keeps its last known sessions');
  assert.deepEqual(hostStatus(offline[0], 6000), { label: '重连中 5s', tone: 'bad' });
  assert.deepEqual(hostStatus({ id: 'h1', name: 'ws', state: 'version' }), { label: '版本不一致', tone: 'warn' });
  assert.deepEqual(hostSections([local], null, {}, {}, new Set(), []).map(section => section.id), ['local'], 'without remote hosts there is one section');
});

test('title bar system figures: CPU and rates come from two samples, widths stay fixed', () => {
  const GIB = 1024 ** 3;
  const first: SystemSample = { at: 10_000, cores: 8, cpuIdle: 1000, cpuTotal: 2000, memTotal: 32 * GIB, memAvailable: 22 * GIB, net: { rx: 0, tx: 0 } };
  const lone = systemModel(null, first);
  assert.equal(lone.cpu, null);
  assert.equal(lone.net, null);
  assert.equal(lone.mem, '10.0/32.0G');
  assert.equal(lone.memTone, '');
  const next: SystemSample = { ...first, at: 12_000, cpuIdle: 1100, cpuTotal: 3000, memAvailable: 2 * GIB, net: { rx: 2 * 1.5 * 1024 ** 2, tx: 2 * 85 * 1024 } };
  const model = systemModel(first, next);
  assert.equal(model.cpu, ' 90%');
  assert.equal(model.cpuTone, 'danger');
  assert.equal(model.memTone, 'danger');
  assert.equal(model.net, '↓1.5M ↑ 85K');
  assert.match(model.detail, /CPU 90%（8 核）/);
  // A counter reset reads as no traffic, not a negative rate; no CPU time elapsed reads as unknown.
  const reset = systemModel(next, { ...next, at: 14_000, net: { rx: 0, tx: 0 } });
  assert.equal(reset.net, '↓0.0K ↑0.0K');
  assert.equal(reset.cpu, null);
  // Windows reports no network counters.
  const windows = systemModel({ ...first, net: null }, { ...next, net: null });
  assert.equal(windows.net, null);
  assert.match(windows.detail, /此平台未采集/);
  assert.equal(systemModel(first, { ...next, memAvailable: 8 * GIB }).memTone, 'warn');
});

test('rates are four characters wide across unit changes', () => {
  for (const [bytes, text] of [[0, '0.0K'], [512, '0.5K'], [85 * 1024, ' 85K'], [999 * 1024, '999K'], [1000 * 1024, '1.0M'],
    [12.3 * 1024 ** 2, ' 12M'], [2 * 1024 ** 3, '2.0G']] as const) assert.equal(formatRate(bytes), text);
});

test('the title bar clock shows the sampled machine its own local time', () => {
  const at = Date.UTC(2026, 10, 21, 15, 4);
  assert.equal(formatClock(at, 480), '23:04');
  assert.equal(formatClock(at, -300), '10:04');
  assert.equal(formatClock(at, 330), '20:34');
  assert.equal(formatClock(at, 600), '01:04');
  const sample: SystemSample = { at, utcOffset: -210, cores: 4, cpuIdle: 0, cpuTotal: 0, memTotal: 1, memAvailable: 1, net: null };
  const model = systemModel(null, sample);
  assert.equal(model.clock, '11:34');
  assert.match(model.detail, /时间 11:34（UTC-03:30）/);
  // Builds before the offset existed, or a nonsense value, show no remote clock rather than a wrong one.
  assert.equal(systemModel(null, { ...sample, utcOffset: undefined }).clock, null);
  assert.equal(systemModel(null, { ...sample, utcOffset: 5000 }).clock, null);
});
