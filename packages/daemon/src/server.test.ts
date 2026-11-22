import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { Daemon } from './server.ts';
import type { DaemonOptions } from './server.ts';
import { IDLE_AFTER_MS } from './state.ts';
import { KimiQuota } from './kimi-quota.ts';
import { Client } from '../../protocol/src/client.ts';
import type { SessionInfo, ServerEvent, HookEnvelope, Identity, RemoteSession } from '../../protocol/src/index.ts';
import { SESSION_BUSY, UPLOAD_MAX_BYTES, UPLOAD_PART_BYTES, VERSION } from '../../protocol/src/index.ts';
import { normalizeHookPayload } from '../../cli/src/hook.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, '.tmp/app-m0-validation');
async function setup(options: DaemonOptions = {}) {
  await mkdir(base, { recursive: true });
  // Socket paths on macOS need to fit sockaddr_un as well.
  const dir = await mkdtemp(path.join(base, 'd-'));
  const daemon = new Daemon(dir, options);
  await daemon.start();
  const clients: Client[] = [];
  return { daemon, dir, async connect() { const c = await Client.connect(daemon.socketPath); clients.push(c); return c; },
    async cleanup() { clients.forEach(c => c.close()); await daemon.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error('condition not reached');
}
function watch(client: Client) {
  const events: ServerEvent[] = [];
  client.on('event', event => events.push(event));
  return events;
}
function terminalText(events: ServerEvent[]) {
  return events.flatMap(event => event.type === 'output' || event.type === 'snapshot' ? [Buffer.from(event.data, 'base64').toString()] : []).join('');
}
function lastSeq(events: ServerEvent[], snapshot: Extract<ServerEvent, { type: 'snapshot' }>): number {
  return Math.max(snapshot.seq, ...events.flatMap(event => event.type === 'output' || event.type === 'resize' ? [event.seq] : []));
}
// Input is accepted only after the replay has been acknowledged up to its target.
async function catchUp(client: Client, events: ServerEvent[], identity: { sessionId: string; instanceId: string }) {
  await waitFor(() => events.some(event => event.type === 'snapshot'));
  const snapshot = events.findLast(event => event.type === 'snapshot');
  assert.ok(snapshot?.type === 'snapshot');
  await waitFor(() => lastSeq(events, snapshot) >= snapshot.target);
  await client.request({ type: 'ack', sessionId: identity.sessionId, instanceId: identity.instanceId, seq: lastSeq(events, snapshot) });
  return snapshot;
}
async function create(client: Client, extra = {}) {
  return client.request<SessionInfo>({ type: 'create', options: {
    command: process.execPath, args: [path.join(root, 'packages/daemon/test/fake-agent.mjs')],
    cwd: base, cols: 80, rows: 24,
    env: { CLAUDE_CONFIG_DIR: path.join(base, 'isolated-claude'), CODEX_HOME: path.join(base, 'isolated-codex') }, ...extra,
  } });
}
async function listAll(client: Client): Promise<SessionInfo[]> {
  return client.request<SessionInfo[]>({ type: 'list' });
}
async function sessionOf(client: Client, identity: { sessionId: string }): Promise<SessionInfo> {
  const found = (await listAll(client)).find(item => item.sessionId === identity.sessionId);
  if (!found) throw new Error(`session ${identity.sessionId} missing from list`);
  return found;
}
function hook(info: SessionInfo, eventId: string, name: string, rest = {}): HookEnvelope {
  return { eventId, sessionId: info.sessionId, instanceId: info.instanceId, provider: 'claude', agentPid: info.pid,
    payload: { hook_event_name: name, session_id: 'agent-session', turn_id: 'turn-1', ...rest } };
}

// The socket is listening before start() has finished loading; a stop() in that window (the bridge
// waits only for the socket) must not leave the probe timer keeping the process alive.
test('a stop that arrives while start is still loading leaves no timer behind', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'd-'));
  const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  const before = timers();
  const daemon = new Daemon(dir);
  let stopped: Promise<void> | undefined;
  (daemon as unknown as { server: import('node:net').Server }).server.once('listening', () => { stopped = daemon.stop(); });
  try {
    await daemon.start().catch(() => {});
    await stopped;
    assert.equal(timers(), before);
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('a session left waiting is broadcast as idle after the TUI threshold and resumes on new input', async context => {
  const t = await setup();
  try {
    const client = await t.connect();
    const events = watch(client);
    const info = await create(client, { env: { TARMAC_TEST_PROVIDER: 'codex' } });
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'codex');
    const event = (id: string, name: string, rest = {}): HookEnvelope => ({ ...hook(info, id, name, { session_id: 'codex-idle', ...rest }), provider: 'codex' });
    await client.request({ type: 'hook', event: event('idle-start', 'SessionStart') });
    await client.request({ type: 'hook', event: event('idle-prompt', 'UserPromptSubmit', { prompt: 'go' }) });
    await client.request({ type: 'hook', event: event('idle-stop', 'Stop') });
    assert.equal((await sessionOf(client, info)).agent?.activity, 'waiting');
    // Only Date is faked: the 500 ms probe keeps running on real timers and must announce idleness.
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const idleInfo = () => events.some(item => item.type === 'info' && item.session.sessionId === info.sessionId && item.session.agent?.activity === 'idle');
    context.mock.timers.tick(IDLE_AFTER_MS - 1000);
    await delay(1200);
    assert.equal(idleInfo(), false, 'still waiting before the threshold');
    context.mock.timers.tick(1000);
    for (let tries = 0; tries < 100 && !idleInfo(); tries++) await delay(20);
    assert.ok(idleInfo(), 'the probe broadcast idle without any new event');
    assert.equal((await sessionOf(client, info)).agent?.activity, 'idle');
    await client.request({ type: 'hook', event: event('idle-resume', 'UserPromptSubmit', { prompt: 'again', turn_id: 'turn-2' }) });
    assert.equal((await sessionOf(client, info)).agent?.activity, 'working');
  } finally { context.mock.timers.reset(); await t.cleanup(); }
});

test('real PTY survives UI disconnect; restore, input, resize, control transfer and exit work', async () => {
  const t = await setup();
  try {
    const first = await t.connect();
    const events = watch(first);
    const info = await create(first);
    await waitFor(async () => (await sessionOf(first, info)).foreground?.provider === 'claude');
    await first.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
    const snapshot = events.find(e => e.type === 'snapshot'); assert.ok(snapshot?.type === 'snapshot');
    assert.ok(snapshot.target > snapshot.seq, 'READY output is part of the replay');
    await assert.rejects(first.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'early\n' }), /not ready/);
    await first.request({ type: 'ack', sessionId: info.sessionId, instanceId: info.instanceId, seq: snapshot.seq });
    await assert.rejects(first.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'partial\n' }), /not ready/);
    await catchUp(first, events, info);
    await first.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: '你好\n' });
    await waitFor(() => terminalText(events).includes('INPUT:你好'));
    await first.request({ type: 'resize', sessionId: info.sessionId, instanceId: info.instanceId, cols: 100, rows: 30 });
    await waitFor(() => terminalText(events).includes('SIZE:100x30'));
    first.close();
    const second = await t.connect(); const restored = watch(second);
    await second.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
    assert.equal((await sessionOf(second, info)).pid, info.pid);
    await catchUp(second, restored, info);
    assert.ok(terminalText(restored).includes('INPUT:你好'));
    assert.ok(restored.some(event => event.type === 'resize' && event.cols === 100), 'replay carries the recorded resize');
    await assert.rejects(second.request({ type: 'resize', sessionId: info.sessionId, instanceId: 'old', cols: 90, rows: 20 }), /stale/);
    await assert.rejects(second.request({ type: 'ack', sessionId: info.sessionId, instanceId: info.instanceId, seq: Number.MAX_SAFE_INTEGER }), /invalid/);
    await second.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: Buffer.from('quit\n').toString('base64'), binary: true });
    await waitFor(async () => !(await sessionOf(second, info)).alive);
    assert.equal((await sessionOf(second, info)).exitCode, 7);
    assert.equal((await stat(t.daemon.socketPath)).mode & 0o777, 0o600);
  } finally { await t.cleanup(); }
});

test('hook journal ACK, dedup, instance rejection, read position and restart preserve input records', async () => {
  const t = await setup();
  let restarted: Daemon | undefined;
  try {
    const client = await t.connect();
    const info = await create(client);
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'claude');
    await client.request({ type: 'hook', event: hook(info, 'start', 'SessionStart') });
    const event = hook(info, 'prompt-1', 'UserPromptSubmit', { prompt: 'one\ntwo 中文' });
    assert.deepEqual(await client.request({ type: 'hook', event }), { duplicate: false });
    assert.deepEqual(await client.request({ type: 'hook', event }), { duplicate: true });
    const current = await sessionOf(client, info);
    assert.equal(current.hooks.verified, true);
    assert.equal(current.history.records.length, 1);
    assert.equal(current.agent?.activity, 'working');
    await assert.rejects(client.request({ type: 'hook', event: { ...event, instanceId: 'old' } }), /stale/);
    await client.request({ type: 'read', sessionId: info.sessionId, instanceId: info.instanceId, seq: current.history.records[0].seq });
    assert.equal((await sessionOf(client, info)).history.unread, 0);
    assert.ok((await readFile(path.join(t.dir, 'events.jsonl'), 'utf8')).includes('one\\ntwo'));
    client.close();
    await t.daemon.stop();
    restarted = new Daemon(t.dir); await restarted.start();
    const next = await Client.connect(restarted.socketPath);
    try {
      const restored = await sessionOf(next, info);
      assert.equal(restored.alive, false);
      assert.equal(restored.history.records[0].prompt, 'one\ntwo 中文');
      assert.equal(restored.history.unread, 0);
      assert.equal(restored.hooks.verified, false);
      await assert.rejects(next.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId }), /persisted/);
    } finally { next.close(); }
  } finally { await restarted?.stop(); await t.cleanup(); }
});

test('token totals follow the exact hook conversation, update on append and clear on exit', async () => {
  const t = await setup();
  const row = (sessionId: string, id: string, input: number) => JSON.stringify({ type: 'assistant', sessionId,
    message: { id, usage: { input_tokens: input, output_tokens: 10 } } }) + '\n';
  try {
    const client = await t.connect();
    const info = await create(client);
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'claude');
    const first = path.join(t.dir, 'first.jsonl');
    const second = path.join(t.dir, 'second.jsonl');
    await writeFile(first, row('agent-session', 'm1', 100));
    await writeFile(second, row('next-session', 'm2', 200));
    await client.request({ type: 'hook', event: hook(info, 'start-usage', 'SessionStart', { transcript_path: first }) });
    await waitFor(async () => (await sessionOf(client, info)).usage?.totalTokens === 110);
    await appendFile(first, row('agent-session', 'm3', 300));
    await waitFor(async () => (await sessionOf(client, info)).usage?.totalTokens === 420);
    await client.request({ type: 'hook', event: hook(info, 'switch-usage', 'SessionStart', { session_id: 'next-session', transcript_path: second }) });
    assert.notEqual((await sessionOf(client, info)).usage?.agentSessionId, 'agent-session');
    await waitFor(async () => (await sessionOf(client, info)).usage?.totalTokens === 210);
    await client.request({ type: 'hook', event: hook(info, 'retired-usage', 'Stop', { transcript_path: first }) });
    await client.request({ type: 'hook', event: hook(info, 'sub-usage', 'SubagentStop', {
      session_id: 'next-session', agent_id: 'sub', transcript_path: first,
    }) });
    await delay(1200);
    assert.equal((await sessionOf(client, info)).usage?.agentSessionId, 'next-session');
    assert.equal((await sessionOf(client, info)).usage?.totalTokens, 210);
    await writeFile(second, row('wrong-session', 'bad', 999));
    await waitFor(async () => Boolean((await sessionOf(client, info)).usageError));
    assert.equal((await sessionOf(client, info)).usage, undefined);
    const events = watch(client);
    await client.request({ type: 'attach', ...{ sessionId: info.sessionId, instanceId: info.instanceId } });
    await catchUp(client, events, info);
    await client.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'quit\n' });
    await waitFor(async () => !(await sessionOf(client, info)).alive);
    assert.equal((await sessionOf(client, info)).usage, undefined);
    assert.equal((await sessionOf(client, info)).usageError, undefined);
  } finally { await t.cleanup(); }
});

test('current Codex process open file supplies token totals without installing hooks', async () => {
  const t = await setup();
  try {
    const file = path.join(t.dir, 'rollout-2026-11-15-00000000-0000-4000-8000-000000000000.jsonl');
    const data = JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: 1000, output_tokens: 200, cached_input_tokens: 800, total_tokens: 1200,
      } } } }) + '\n';
    await writeFile(file, data);
    const client = await t.connect();
    const launched = await create(client, { env: { CLAUDE_CONFIG_DIR: path.join(t.dir, 'claude'), CODEX_HOME: path.join(t.dir, 'codex'),
      TARMAC_TEST_PROVIDER: 'codex', TARMAC_TEST_TRANSCRIPT: file } });
    await waitFor(async () => (await sessionOf(client, launched)).usage?.totalTokens === 1200);
    const current = await sessionOf(client, launched);
    assert.equal(current.agent, null, 'usage discovery does not invent activity or hook verification');
    assert.equal(current.hooks.verified, false);
    assert.equal(current.usage?.agentSessionId, 'codex-session');
    assert.equal(current.usage?.agentRunId, String(current.foreground?.pid));
    assert.equal(await readFile(file, 'utf8'), data);
  } finally { await t.cleanup(); }
});

test('npm Codex launcher resolves the native child owning tokens and quota in a real PTY', async () => {
  const t = await setup();
  try {
    const file = path.join(t.dir, 'rollout-wrapper-00000000-0000-4000-8000-000000000000.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'wrapped-session' } }) + '\n'
      + JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', type: 'event_msg', payload: { type: 'token_count',
        info: { total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } },
        rate_limits: { limit_id: 'codex', primary: { window_minutes: 300, used_percent: 37, resets_at: 2000000000 } },
      } }) + '\n');
    const wrapper = path.join(t.dir, '@openai/codex/bin/codex.js');
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, `import {spawn} from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(path.join(root, 'packages/daemon/test/fake-agent.mjs'))}], {stdio: 'inherit'});
for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', () => process.exit(0));\n`);
    const client = await t.connect();
    const launched = await create(client, { args: [wrapper, '-p', 'deepseek'], env: {
      TARMAC_TEST_PROVIDER: 'codex', TARMAC_TEST_TRANSCRIPT: file, CODEX_HOME: path.join(t.dir, 'codex'),
    } });
    const events = watch(client);
    await client.request({ type: 'attach', sessionId: launched.sessionId, instanceId: launched.instanceId });
    await catchUp(client, events, launched);
    try {
      await waitFor(async () => (await sessionOf(client, launched)).usage?.totalTokens === 1200);
    } catch (cause) {
      throw new Error(JSON.stringify({ current: await sessionOf(client, launched), output: terminalText(events) }), { cause });
    }
    const current = await sessionOf(client, launched);
    assert.notEqual(current.foreground?.pid, launched.pid, 'transcript owner is the launcher child');
    assert.equal(current.usage?.agentRunId, String(current.foreground?.pid));
    assert.equal(current.usage?.agentSessionId, 'wrapped-session');
    assert.equal(current.foreground?.profile, 'deepseek');
    assert.equal(current.usage?.rateLimits?.windows[0].usedPercent, 37);
    await client.request({ type: 'close', sessionId: launched.sessionId, instanceId: launched.instanceId });
    await waitFor(async () => !(await sessionOf(client, launched)).alive);
    assert.equal((await sessionOf(client, launched)).usage, undefined);
  } finally { await t.cleanup(); }
});

test('Kimi and Antigravity real PTYs retain native interaction without acquiring Claude hooks or usage', async () => {
  for (const provider of ['kimi', 'agy']) {
    const t = await setup();
    // The daemon runs in this process and inspects hooks under os.homedir(); keep the user's real
    // ~/.gemini and Kimi configuration out of the result.
    const home = process.env.HOME;
    process.env.HOME = t.dir;
    try {
      const client = await t.connect();
      const events = watch(client);
      const info = await create(client, { env: { TARMAC_TEST_PROVIDER: provider === 'kimi' ? 'kimi-code' : provider } });
      await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === provider);
      const current = await sessionOf(client, info);
      assert.equal(current.agent, null);
      assert.equal(current.hooks.configured, false);
      if (provider === 'agy') assert.match(current.hooks.source ?? '', /user\/workspace JSON hooks/);
      else assert.match(current.hooks.source ?? '', /Kimi TOML/);
      assert.equal(current.usage, undefined);
      await client.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
      await catchUp(client, events, info);
      await client.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: '你好\n' });
      await waitFor(() => terminalText(events).includes('INPUT:你好'));
      await client.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'quit\n' });
      await waitFor(async () => !(await sessionOf(client, info)).alive);
    } finally { process.env.HOME = home; await t.cleanup(); }
  }
});

test('Claude without transcript fd reports tokens and matching status cache; after a session change it remains only as the account snapshot', async () => {
  const t = await setup();
  const first = '00000000-0000-4000-8000-000000000011';
  const second = '00000000-0000-4000-8000-000000000012';
  try {
    const config = path.join(t.dir, 'claude');
    const project = path.join(config, 'projects', t.dir.replace(/[^a-zA-Z0-9]/g, '-'));
    const bin = path.join(t.dir, 'bin');
    const cache = path.join(t.dir, 'config/token-tracker/tt-status.json');
    const agents = path.join(t.dir, 'agents.json');
    await Promise.all([mkdir(project, { recursive: true }), mkdir(bin), mkdir(path.dirname(cache), { recursive: true })]);
    await writeFile(agents, '[]');
    await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(agents)}, 'utf8'));`, { mode: 0o700 });
    const transcript = (sessionId: string) => path.join(project, `${sessionId}.jsonl`);
    const row = (sessionId: string, input: number) => JSON.stringify({ type: 'assistant', sessionId, message: {
      id: sessionId, usage: { input_tokens: input, output_tokens: 10 },
    } }) + '\n';
    await writeFile(transcript(first), row(first, 100));
    await writeFile(transcript(second), row(second, 200));
    await writeFile(cache, JSON.stringify({ session_id: first, transcript_path: transcript(first),
      _received_at: '2026-11-15T07:21:00Z', rate_limits: { five_hour: { used_percentage: 0, resets_at: 2000000000 } } }));
    const client = await t.connect();
    const launched = await create(client, { cwd: t.dir, env: {
      CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(t.dir, 'config'), PATH: bin + path.delimiter + process.env.PATH,
    } });
    await writeFile(agents, JSON.stringify([{ pid: launched.pid, cwd: t.dir, sessionId: first }]));
    await waitFor(async () => (await sessionOf(client, launched)).usage?.totalTokens === 110);
    const current = await sessionOf(client, launched);
    assert.equal(current.usage?.rateLimits?.windows[0].usedPercent, 0);
    assert.equal(current.usage?.rateLimits?.source, undefined, 'the matching cache is this session\'s own snapshot');
    assert.equal(current.hooks.verified, false);
    await writeFile(agents, JSON.stringify([{ pid: launched.pid, cwd: t.dir, sessionId: second }]));
    await waitFor(async () => (await sessionOf(client, launched)).usage?.totalTokens === 210);
    const switched = await sessionOf(client, launched);
    assert.equal(switched.usage?.agentSessionId, second);
    // Same configuration directory, so the quota is the account's (docs/app-m0-spec.md); the old
    // conversation's own snapshot does not follow, it is offered only as a shared one.
    assert.equal(switched.usage?.rateLimits?.source, 'shared', 'old conversation quota follows only as the account snapshot');
    assert.equal(switched.usage?.rateLimits?.windows[0].usedPercent, 0);
  } finally { await t.cleanup(); }
});

test('each hook failure marker is read once, including those of other sessions', async () => {
  // Markers never change owner. Re-reading other sessions' markers on every 500 ms probe cost
  // ~1 core per session once thousands had accumulated.
  const t = await setup();
  try {
    const client = await t.connect();
    const info = await create(client);
    const dir = path.join(t.dir, 'hook-failures');
    const marker = (owner: Identity, reason: string) => JSON.stringify({ eventId: randomUUID(), sessionId: owner.sessionId,
      instanceId: owner.instanceId, provider: 'claude', at: new Date().toISOString(), reason }) + '\n';
    const foreign = path.join(dir, `${randomUUID()}.json`);
    await writeFile(foreign, marker({ sessionId: randomUUID(), instanceId: randomUUID() }, 'rejected'));
    await writeFile(path.join(dir, `${randomUUID()}.json`), marker(info, 'timeout'));
    await waitFor(async () => (await sessionOf(client, info)).hooks.error === '已知输入采集缺失：timeout');
    // Only a re-read would notice this rewrite; it must not happen across several probes.
    await writeFile(foreign, marker(info, 'rejected'));
    await delay(2000);
    assert.equal((await sessionOf(client, info)).hooks.error, '已知输入采集缺失：timeout');
  } finally { await t.cleanup(); }
});

test('v3 reads a v2 registry without reviving processes or verified hooks', async () => {
  const t = await setup();
  let restarted: Daemon | undefined;
  try {
    const client = await t.connect();
    const info = await create(client);
    await t.daemon.stop();
    const file = path.join(t.dir, 'registry.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.v = 2;
    saved.sessions[0].session.alive = true;
    saved.sessions[0].session.hooks.verified = true;
    await writeFile(file, JSON.stringify(saved));
    restarted = new Daemon(t.dir);
    await restarted.start();
    const next = await Client.connect(restarted.socketPath);
    try {
      const restored = await sessionOf(next, info);
      assert.equal(restored.alive, false);
      assert.equal(restored.agent, null);
      assert.equal(restored.hooks.verified, false);
      assert.equal(restored.usage, undefined);
    } finally { next.close(); }
  } finally { await restarted?.stop(); await t.cleanup(); }
});

test('statusLine snapshots stay isolated across Claude PTYs without verifying lifecycle hooks', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const a = await create(client);
    const b = await create(client);
    await waitFor(async () => (await listAll(client)).every(info => info.foreground?.provider === 'claude'));
    for (const [info, id, percent] of [[a, 'claude-a', 12], [b, 'claude-b', 78]] as const) {
      const file = path.join(t.dir, `${id}.jsonl`);
      await writeFile(file, JSON.stringify({ type: 'assistant', sessionId: id, message: { id: 'm', usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
      await client.request({ type: 'hook', event: hook(info, `snapshot-${id}`, 'StatusLine', {
        session_id: id, transcript_path: file, rate_limits: { five_hour: { used_percentage: percent, resets_at: 2000000000 } },
      }) });
    }
    for (const [info, percent] of [[a, 12], [b, 78]] as const) {
      const current = await sessionOf(client, info);
      assert.equal(current.usage?.totalTokens, 120);
      assert.equal(current.usage?.rateLimits?.windows[0].usedPercent, percent);
      assert.equal(current.hooks.verified, false);
      assert.equal(current.agent, null);
      assert.equal(current.history.records.length, 0);
    }
    await assert.rejects(client.request({ type: 'hook', event: { ...hook(b, 'wrong-process-snapshot', 'StatusLine'), agentPid: a.pid } }), /does not belong/);
    assert.equal(await readFile(path.join(t.dir, 'events.jsonl'), 'utf8'), '');
    const stale = hook(a, 'stale-snapshot', 'StatusLine', { session_id: 'claude-a',
      transcript_path: path.join(t.dir, 'claude-a.jsonl'), rate_limits: { five_hour: { used_percentage: 99, resets_at: 2000000000 } } });
    stale.hookStartedAt = 1000;
    await client.request({ type: 'hook', event: stale });
    assert.equal((await sessionOf(client, a)).usage?.rateLimits?.windows[0].usedPercent, 12);
  } finally { await t.cleanup(); }
});

test('Claude quota is shared by sessions of one configuration directory, never across directories', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const [a, b, other] = [await create(client), await create(client), await create(client)];
    await waitFor(async () => (await listAll(client)).every(info => info.foreground?.provider === 'claude'));
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
    const transcript = async (config: string, id: string) => {
      const file = path.join(t.dir, config, 'projects', '-proj', `${id}.jsonl`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'assistant', sessionId: id, message: { id: 'm', usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
      return file;
    };
    const status = (info: SessionInfo, id: string, file: string, at: number, percent?: number) => {
      const event = hook(info, `status-${id}-${at}`, 'StatusLine', { session_id: id, transcript_path: file,
        ...(percent === undefined ? {} : { rate_limits: { five_hour: { used_percentage: percent, resets_at: 2000000000 } } }) });
      event.hookStartedAt = at;
      return client.request({ type: 'hook', event });
    };
    const files = [await transcript('account', ids[0]), await transcript('account', ids[1]), await transcript('elsewhere', ids[2])];
    const now = Date.now();
    await status(a, ids[0], files[0], now - 2000, 40);
    // b was just resumed: its status line has no quota yet, the account's does.
    await status(b, ids[1], files[1], now - 1000);
    await status(other, ids[2], files[2], now - 1000);
    await waitFor(async () => (await sessionOf(client, b)).usage?.rateLimits?.source === 'shared');
    assert.equal((await sessionOf(client, b)).usage?.rateLimits?.windows[0].usedPercent, 40);
    assert.equal((await sessionOf(client, a)).usage?.rateLimits?.source, undefined, 'a shows its own snapshot');
    await delay(2500);
    assert.equal((await sessionOf(client, other)).usage?.rateLimits, undefined, 'another directory is another account');
    // A newer snapshot from b becomes b's own and reaches a as the account's latest.
    await status(b, ids[1], files[1], now, 55);
    assert.deepEqual([(await sessionOf(client, b)).usage?.rateLimits?.source, (await sessionOf(client, b)).usage?.rateLimits?.windows[0].usedPercent], [undefined, 55]);
    await waitFor(async () => (await sessionOf(client, a)).usage?.rateLimits?.windows[0].usedPercent === 55);
    assert.equal((await sessionOf(client, a)).usage?.rateLimits?.source, 'shared');
  } finally { await t.cleanup(); }
});

test('a failed usage read names its cause, is logged once without content and is retried after the delay', async context => {
  const t = await setup();
  try {
    const client = await t.connect();
    const info = await create(client);
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'claude');
    const file = path.join(t.dir, 'broken.jsonl');
    const row = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 'agent-session', message: { id, usage: { input_tokens: 100, output_tokens: 10 } } }) + '\n';
    // As if the reader met half of a line that was being rewritten in place.
    await writeFile(file, row('m1') + '{"type":"assistant","prompt":"PRIVATE-TEXT\n');
    await client.request({ type: 'hook', event: hook(info, 'broken-start', 'SessionStart', { transcript_path: file }) });
    await waitFor(async () => (await sessionOf(client, info)).usageError === '暂时无法读取当前会话用量：会话记录有一行不是合法 JSON');
    // Same inode, longer and now valid: only the retry can recover, the failed reader stays failed.
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    await writeFile(file, row('m1') + row('m2') + row('m3'));
    await delay(2500);
    assert.equal((await sessionOf(client, info)).usage, undefined);
    context.mock.timers.tick(10_001);
    for (let tries = 0; tries < 150 && (await sessionOf(client, info)).usage?.totalTokens !== 330; tries++) await delay(20);
    assert.equal((await sessionOf(client, info)).usage?.totalTokens, 330);
    assert.equal((await sessionOf(client, info)).usageError, undefined);
    const log = await readFile(path.join(t.dir, 'daemon.log'), 'utf8');
    assert.equal(log.match(/usage read failed \(claude\)/g)?.length, 1, 'one line per distinct cause');
    assert.doesNotMatch(log, /PRIVATE-TEXT|broken\.jsonl/);
  } finally { context.mock.timers.reset(); await t.cleanup(); }
});

test('Codex hook-only counts are partial, deduplicated and replaced by exact transcript totals', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const info = await create(client, { env: { TARMAC_TEST_PROVIDER: 'codex' } });
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'codex');
    const event = (id: string, name: string, rest = {}): HookEnvelope => ({ ...hook(info, id, name, { session_id: 'codex-exact', ...rest }), provider: 'codex' });
    await client.request({ type: 'hook', event: event('codex-start', 'SessionStart') });
    const counted = event('request-one', 'PostModelRequest', { token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } });
    await client.request({ type: 'hook', event: counted });
    await client.request({ type: 'hook', event: counted });
    let current = await sessionOf(client, info);
    assert.equal(current.usage?.totalTokens, 120);
    assert.equal(current.usage?.scope, 'observed');
    const file = path.join(t.dir, 'codex.jsonl');
    await writeFile(file, [
      { type: 'session_meta', payload: { id: 'codex-exact', model_provider: 'deepseek' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 200 } } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await client.request({ type: 'hook', event: event('codex-stop', 'Stop', { transcript_path: file }) });
    current = await sessionOf(client, info);
    assert.equal(current.usage?.totalTokens, 1200);
    assert.equal(current.usage?.scope, undefined);
    assert.equal(current.agent?.activity, 'waiting');
    await client.request({ type: 'hook', event: event('late-request', 'PostModelRequest', { token_usage: { input_tokens: 50, output_tokens: 5 } }) });
    assert.equal((await sessionOf(client, info)).usage?.totalTokens, 1200);
  } finally { await t.cleanup(); }
});

test('Kimi hooks drive status, prompt history and exact wire usage for parallel PTYs', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const home = path.join(t.dir, 'kimi');
    for (const [id, amount] of [['kimi-a', 100], ['kimi-b', 500]] as const) {
      const file = path.join(home, 'sessions/project', id, 'agents/main/wire.jsonl');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'usage.record', usage: { inputOther: amount, output: 20, inputCacheRead: 30 } }) + '\n');
      const info = await create(client, { env: { TARMAC_TEST_PROVIDER: 'kimi-code', KIMI_CODE_HOME: home } });
      await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'kimi');
      const event = (name: string, at: number, payload = {}): HookEnvelope => ({ ...hook(info, `${id}-${name}`, name,
        { session_id: id, turn_id: undefined, ...payload }), provider: 'kimi', hookStartedAt: at,
        payload: normalizeHookPayload('kimi', { hook_event_name: name, session_id: id, ...payload }) });
      await client.request({ type: 'hook', event: event('SessionStart', 1000) });
      await client.request({ type: 'hook', event: event('UserPromptSubmit', 1100, { prompt: [{ type: 'text', text: id }] }) });
      await client.request({ type: 'hook', event: event('TurnStarted', 1200, { turn_id: 1, origin_kind: 'user' }) });
      assert.equal((await sessionOf(client, info)).agent?.activity, 'working');
      await client.request({ type: 'hook', event: event('Stop', 1300) });
      const current = await sessionOf(client, info);
      assert.equal(current.agent?.activity, 'waiting');
      assert.equal(current.usage?.totalTokens, amount + 50);
      assert.equal(current.history.records[0].prompt, id);
      assert.equal(current.hooks.verified, true);
    }
    const sessions = await listAll(client);
    assert.equal(sessions[0].usage?.totalTokens, 150);
    assert.equal(sessions[1].usage?.totalTokens, 550);
  } finally { await t.cleanup(); }
});

test('Kimi wire turn.ended completes the open turn when the Stop hook never arrives', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const home = path.join(t.dir, 'kimi');
    const id = 'kimi-no-stop';
    const file = path.join(home, 'sessions/project', id, 'agents/main/wire.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    // An earlier turn's end and a subagent end must not close the new turn.
    await writeFile(file, [
      { type: 'turn.ended', agentId: 'main', turnId: 6, reason: 'completed', time: 900 },
      { type: 'turn.ended', agentId: 'sub', turnId: 7, reason: 'completed', time: 1500 },
      { type: 'usage.record', usage: { inputOther: 100, output: 20 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const info = await create(client, { env: { TARMAC_TEST_PROVIDER: 'kimi-code', KIMI_CODE_HOME: home } });
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'kimi');
    const event = (name: string, at: number, payload = {}): HookEnvelope => ({ ...hook(info, `${id}-${name}`, name,
      { session_id: id, turn_id: undefined, ...payload }), provider: 'kimi', hookStartedAt: at,
      payload: normalizeHookPayload('kimi', { hook_event_name: name, session_id: id, ...payload }) });
    await client.request({ type: 'hook', event: event('SessionStart', 1000) });
    await client.request({ type: 'hook', event: event('UserPromptSubmit', 1100, { prompt: [{ type: 'text', text: 'go' }] }) });
    await client.request({ type: 'hook', event: event('TurnStarted', 1200, { turn_id: 7, origin_kind: 'user' }) });
    await waitFor(async () => (await sessionOf(client, info)).usage?.totalTokens === 120);
    assert.equal((await sessionOf(client, info)).agent?.activity, 'working');
    await appendFile(file, JSON.stringify({ type: 'turn.ended', agentId: 'main', turnId: 7, reason: 'completed', time: 2000 }) + '\n');
    await waitFor(async () => (await sessionOf(client, info)).agent?.activity === 'waiting');
    assert.equal((await sessionOf(client, info)).history.records[0].prompt, 'go');
  } finally { await t.cleanup(); }
});

test('a Kimi session carries its account quota while the access token never leaves the request', async () => {
  const requests: { url: string; authorization: string }[] = [];
  const quota = new KimiQuota(async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization });
    return { ok: true, json: async () => ({ usages: { limit_5h: { used_ratio: 0.07, reset_time: '2099-01-01T05:00:00Z' },
      limit_7d: { used_ratio: 0.33, reset_time: '2099-01-07T00:00:00Z' } } }) };
  });
  const t = await setup({ kimiQuota: quota });
  try {
    const client = await t.connect();
    const events = watch(client);
    const home = path.join(t.dir, 'kimi');
    const id = 'kimi-quota';
    const file = path.join(home, 'sessions/project', id, 'agents/main/wire.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: 'usage.record', usage: { inputOther: 100, output: 20 } }) + '\n');
    await mkdir(path.join(home, 'credentials'), { recursive: true });
    await writeFile(path.join(home, 'credentials/kimi-code.json'), JSON.stringify({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_at: Date.now() / 1000 + 3600 }));
    const info = await create(client, { env: { TARMAC_TEST_PROVIDER: 'kimi-code', KIMI_CODE_HOME: home } });
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'kimi');
    const event = (name: string, payload = {}): HookEnvelope => ({ ...hook(info, `${id}-${name}`, name, { session_id: id, turn_id: undefined, ...payload }),
      provider: 'kimi', payload: normalizeHookPayload('kimi', { hook_event_name: name, session_id: id, ...payload }) });
    await client.request({ type: 'hook', event: event('SessionStart') });
    await waitFor(async () => (await sessionOf(client, info)).usage?.rateLimits?.windows.length === 2);
    const limits = (await sessionOf(client, info)).usage!.rateLimits!;
    assert.equal(limits.source, 'account');
    assert.deepEqual(limits.windows.map(window => [window.windowMinutes, window.usedPercent]), [[300, 7], [10_080, 33]]);
    assert.deepEqual(requests, [{ url: 'https://api.kimi.com/coding/v1/usages', authorization: 'Bearer secret-access' }]);
    const sent = JSON.stringify([events, await listAll(client)]);
    assert.equal(sent.includes('secret-access') || sent.includes('secret-refresh'), false, 'no token reaches a client');
    const persisted = await readFile(path.join(t.dir, 'registry.json'), 'utf8').catch(() => '');
    assert.equal(persisted.includes('secret-access'), false, 'no token is persisted');
  } finally { await t.cleanup(); }
});

test('shared-daemon Codex binds its rollout by submit evidence, ignores a same-directory external thread and shows screen approval', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const codexHome = path.join(t.dir, 'codex');
    // No TARMAC_TEST_TRANSCRIPT: like a shared app-server client, the PTY process holds no rollout.
    const info = await create(client, { env: { TARMAC_TEST_PROVIDER: 'codex', CODEX_HOME: codexHome } });
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'codex');
    const events = watch(client);
    await client.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
    await catchUp(client, events, info);
    const cwd = (await sessionOf(client, info)).foreground!.cwd;
    const now = new Date();
    const day = path.join(codexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'));
    await mkdir(day, { recursive: true });
    const meta = (id: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta',
      payload: { id, timestamp: new Date().toISOString(), cwd, originator: 'codex-tui', source: 'vscode' } }) + '\n';
    const row = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n';
    const prompt = (text: string, messageId?: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
      metadata: messageId ? { retained_source: { id: { message_id: messageId, role: 'user' }, complete: true } } : {},
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
    const own = path.join(day, 'rollout-own.jsonl');
    const external = path.join(day, 'rollout-external.jsonl');
    await writeFile(own, meta('own-thread'));
    await writeFile(external, meta('external-thread'));
    const send = (data: string) => client.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data });
    await send('go\r');
    await appendFile(own, row({ type: 'task_started', turn_id: 'u1', turn_attribution: { turn_trigger: 'user' } })
      + prompt('# AGENTS.md instructions for /project') + prompt('go', 'm-own-1')
      + row({ type: 'token_count', info: { total_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 } } }));
    await waitFor(async () => (await sessionOf(client, info)).agent?.activity === 'working');
    let current = await sessionOf(client, info);
    assert.equal(current.agent?.agentSessionId, 'own-thread');
    assert.equal(current.hooks.verified, false);
    await waitFor(async () => (await sessionOf(client, info)).usage?.totalTokens === 1000);
    // Without UserPromptSubmit, the bound rollout's typed input becomes this PTY's input record.
    await waitFor(async () => (await sessionOf(client, info)).history.records.length === 1);
    current = await sessionOf(client, info);
    assert.deepEqual(current.history.records.map(r => [r.prompt, r.agentSessionId, r.tarmacSessionId]),
      [['go', 'own-thread', info.sessionId]]);
    // The external thread starts its own turn without an Enter in this PTY: no effect.
    await appendFile(external, row({ type: 'task_started', turn_id: 'x1', turn_attribution: { turn_trigger: 'user' } })
      + prompt('external input', 'm-external-1'));
    await send('print Would you like to run the following command?\r');
    await send('print › 1. Yes, just this once\r');
    await waitFor(async () => (await sessionOf(client, info)).agent?.activity === 'permission');
    current = await sessionOf(client, info);
    assert.equal(current.agent?.agentSessionId, 'own-thread');
    await appendFile(own, row({ type: 'task_complete', turn_id: 'u1' }) + prompt('go', 'm-own-1'));
    await waitFor(async () => (await sessionOf(client, info)).agent?.activity === 'waiting');
    // Neither the external thread's input nor a rewritten copy of our own adds a record.
    assert.deepEqual((await sessionOf(client, info)).history.records.map(r => r.prompt), ['go']);
    await client.request({ type: 'close', sessionId: info.sessionId, instanceId: info.instanceId });
    await waitFor(async () => !(await sessionOf(client, info)).alive);
    assert.equal((await sessionOf(client, info)).usage, undefined);
  } finally { await t.cleanup(); }
});

test('interactive PTY drops inherited NO_COLOR while honoring explicit session configuration', async () => {
  const inherited = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const t = await setup();
  try {
    const client = await t.connect();
    for (const explicit of [false, true]) {
      const events = watch(client);
      const info = await create(client, { command: process.execPath, args: ['-e',
        'process.stdout.write(process.env.NO_COLOR ? "COLOR-DISABLED" : "\\x1b[38;2;166;227;161mCOLOR-ENABLED\\x1b[0m"); setInterval(()=>{},1000);'],
        env: explicit ? { NO_COLOR: '1' } : {},
      });
      await client.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
      await catchUp(client, events, info);
      await waitFor(() => terminalText(events).includes(explicit ? 'COLOR-DISABLED' : 'COLOR-ENABLED'));
      if (!explicit) assert.match(terminalText(events), /\x1b\[38;2;166;227;161mCOLOR-ENABLED/);
      await client.request({ type: 'close', sessionId: info.sessionId, instanceId: info.instanceId });
      await waitFor(async () => !(await sessionOf(client, info)).alive);
    }
  } finally {
    if (inherited === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = inherited;
    await t.cleanup();
  }
});

test('a shell that execs into a tmux client is reported as taken over; tmux started as a child is not', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    // process.title stands in for tmux renaming its client process ("tmux: client").
    const fake = `${JSON.stringify(process.execPath)} -e 'process.title="tmux: client"; process.stdout.write("TP:" + process.env.TERM_PROGRAM); setInterval(()=>{},1000)'`;
    for (const [script, expected] of [[`exec ${fake}`, 'tmux'], [`${fake}; true`, undefined]] as const) {
      const events = watch(client);
      const info = await create(client, { command: '/bin/sh', args: ['-c', script] });
      await client.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
      await catchUp(client, events, info);
      await waitFor(() => terminalText(events).includes('TP:Tarmac'));
      // Exec'd: the PTY process itself is the client. Child: the shell stays the PTY process.
      await waitFor(async () => (await sessionOf(client, info)).foreground?.name === (expected ? 'tmux: client' : 'sh'));
      assert.equal((await sessionOf(client, info)).shellTakeover, expected);
      await client.request({ type: 'close', sessionId: info.sessionId, instanceId: info.instanceId });
      await waitFor(async () => !(await sessionOf(client, info)).alive);
    }
  } finally { await t.cleanup(); }
});

test('corrupt journal leaves the real terminal usable but rejects hook ACK visibly', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'd-'));
  await writeFile(path.join(dir, 'events.jsonl'), 'broken\n');
  const daemon = new Daemon(dir); let client: Client | undefined;
  try {
    await daemon.start(); client = await Client.connect(daemon.socketPath);
    const info = await create(client);
    await waitFor(async () => (await sessionOf(client!, info)).foreground?.provider === 'claude');
    assert.match((await sessionOf(client, info)).history.error ?? '', /初始化失败/);
    await assert.rejects(client.request({ type: 'hook', event: hook(info, 'start', 'SessionStart') }), /store|初始化|unavailable|initialized/i);
    const events = watch(client);
    await client.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
    await catchUp(client, events, info);
    await client.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'still-works\n' });
    await waitFor(() => terminalText(events).includes('INPUT:still-works'));
  } finally { client?.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('concurrent create registers every PTY independently', async () => {
  const t = await setup();
  try {
    const first = await t.connect(); const second = await t.connect();
    const attempts = await Promise.allSettled([create(first), create(second)]);
    assert.deepEqual(attempts.map(result => result.status), ['fulfilled', 'fulfilled']);
    const pids = attempts.map(result => result.status === 'fulfilled' ? result.value.pid : 0);
    assert.notEqual(pids[0], pids[1]);
    const listed = await listAll(first);
    assert.deepEqual(listed.map(item => item.pid).sort(), [...pids].sort());
    assert.ok(listed.every(item => item.alive));
  } finally { await t.cleanup(); }
});

test('large persisted input history is bounded in info without losing durable records', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const info = await create(client);
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'claude');
    for (let index = 0; index < 3; index++) {
      await client.request({ type: 'hook', event: hook(info, `long-${index}`, 'UserPromptSubmit', { prompt: `${index}:` + '中'.repeat(200_000) }) });
    }
    const view = await sessionOf(client, info);
    assert.equal(view.history.records.length, 1);
    assert.match(view.history.displayNote ?? '', /预览/);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 512 * 1024);
    const lines = (await readFile(path.join(t.dir, 'events.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).prompt.length, 200_002);
    assert.equal(view.history.unread, 3);
  } finally { await t.cleanup(); }
});

test('slow subscribers pause at the unacknowledged budget and catch up from the log while PTY keeps running', async () => {
  const t = await setup();
  try {
    const client = await t.connect(); const events = watch(client);
    const info = await create(client);
    await client.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
    await catchUp(client, events, info);
    const sent = () => events.flatMap(event => event.type === 'output' ? [Buffer.from(event.data, 'base64').length] : []).reduce((a, b) => a + b, 0);
    const before = sent();
    // About 5.4 MB of output, more than twice the 2 MiB unacknowledged budget.
    await client.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'flood 200000\n' });
    await waitFor(() => sent() - before > 1024 * 1024);
    await delay(300);
    const paused = sent() - before;
    assert.ok(paused <= 2 * 1024 * 1024 + 256 * 1024, `sent ${paused} bytes without acknowledgement`);
    assert.ok(!events.some(event => event.type === 'resync'));
    assert.equal((await sessionOf(client, info)).alive, true);
    const lines = () => terminalText(events).split('fixture-output-中文').length - 1;
    const ackAll = async () => {
      const snapshot = events.findLast(event => event.type === 'snapshot');
      assert.ok(snapshot?.type === 'snapshot');
      await client.request({ type: 'ack', sessionId: info.sessionId, instanceId: info.instanceId, seq: lastSeq(events, snapshot) });
    };
    await waitFor(async () => { await ackAll(); return lines() >= 200000; });
    await delay(200);
    assert.equal(lines(), 200000, 'every flooded line arrives exactly once');
    const outputs = events.filter(event => event.type === 'output');
    outputs.forEach((event, index) => { if (index) assert.equal(event.first, outputs[index - 1].seq + 1); });
    assert.equal((await sessionOf(client, info)).pid, info.pid);
  } finally { await t.cleanup(); }
});

test('detected configuration stays pending until an accepted hook matches that process', async () => {
  const t = await setup();
  try {
    const settings = path.join(t.dir, 'claude');
    await mkdir(settings, { recursive: true });
    await writeFile(path.join(settings, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
      { type: 'command', command: 'echo test # tarmac-app' },
    ] }] } }));
    const before = await readFile(path.join(settings, 'settings.json'), 'utf8');
    const client = await t.connect();
    const info = await create(client, { provider: 'claude', env: { CLAUDE_CONFIG_DIR: settings }, cwd: t.dir });
    assert.equal(info.hooks.configured, true);
    assert.equal(info.hooks.verified, false);
    assert.match(info.hooks.source ?? '', /JSON only/);
    await waitFor(async () => (await sessionOf(client, info)).foreground?.provider === 'claude');
    await client.request({ type: 'hook', event: hook(info, 'configured-start', 'SessionStart') });
    const verified = await sessionOf(client, info);
    assert.equal(verified.hooks.configured, true);
    assert.equal(verified.hooks.verified, true);
    assert.equal(await readFile(path.join(settings, 'settings.json'), 'utf8'), before);
  } finally { await t.cleanup(); }
});

test('configuration errors are visible while the terminal remains available', async () => {
  const t = await setup();
  try {
    const settings = path.join(t.dir, 'claude');
    await mkdir(settings, { recursive: true });
    await writeFile(path.join(settings, 'settings.json'), 'invalid secret-not-for-diagnostics');
    const client = await t.connect();
    const info = await create(client, { provider: 'claude', env: { CLAUDE_CONFIG_DIR: settings }, cwd: t.dir });
    assert.equal(info.alive, true);
    assert.equal(info.hooks.configured, false);
    assert.equal(info.hooks.verified, false);
    assert.match(info.hooks.configError ?? '', /Invalid JSON/);
    assert.ok(!JSON.stringify(info).includes('secret-not-for-diagnostics'));
  } finally { await t.cleanup(); }
});

test('SIGKILL leaves a marked socket that a new daemon safely recovers with durable input history', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'cr-'));
  const child = spawn(process.execPath, [path.join(root, 'packages/daemon/src/main.ts'), '--data-dir', dir], { stdio: 'ignore' });
  const ended = new Promise(resolve => child.once('exit', resolve));
  let client: Client | undefined;
  let restart: Daemon | undefined;
  let next: Client | undefined;
  try {
    await waitFor(async () => {
      try {
        const connection = await Client.connect(path.join(dir, 'daemon.sock'), 100);
        try { await connection.request({ type: 'list' }); client = connection; return true; }
        catch { connection.close(); return false; }
      } catch { return false; }
    });
    const info = await create(client!, { cwd: dir });
    await waitFor(async () => (await sessionOf(client!, info)).foreground?.provider === 'claude');
    await client!.request({ type: 'hook', event: hook(info, 'crash-start', 'SessionStart') });
    await client!.request({ type: 'hook', event: hook(info, 'crash-prompt', 'UserPromptSubmit', { prompt: 'durable-before-crash' }) });
    child.kill('SIGKILL');
    await ended;
    client!.close();
    assert.equal((await stat(path.join(dir, 'daemon.sock'))).isSocket(), true);
    restart = new Daemon(dir);
    await restart.start();
    next = await Client.connect(restart.socketPath);
    const restored = await sessionOf(next, info);
    assert.equal(restored.alive, false);
    assert.equal(restored.hooks.verified, false);
    assert.equal(restored.history.records[0].prompt, 'durable-before-crash');
    assert.equal(restored.history.unread, 1);
  } finally {
    client?.close(); next?.close();
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await ended; }
    await restart?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('another live daemon and an unknown socket path are never removed by startup', async () => {
  const t = await setup();
  try {
    const second = new Daemon(t.dir);
    await assert.rejects(second.start(), /live daemon/);
    const client = await t.connect();
    assert.deepEqual(await listAll(client), []);
    assert.equal((await stat(t.daemon.socketPath)).isSocket(), true);
  } finally { await t.cleanup(); }
  const dir = await mkdtemp(path.join(base, 'cr-'));
  try {
    const file = path.join(dir, 'daemon.sock');
    await writeFile(file, 'preserve-existing-file');
    const daemon = new Daemon(dir);
    await assert.rejects(daemon.start(), /ownership marker/);
    assert.equal(await readFile(file, 'utf8'), 'preserve-existing-file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- M1 multi-session regressions ------------------------------------------

test('M1 fix: stale attach cannot take control from the current owner', async () => {
  const t = await setup();
  try {
    const first = await t.connect();
    const second = await t.connect();
    const events = watch(first);
    const info = await create(first);
    await first.request({ type: 'attach', ...info });
    await catchSession(first, events, info);
    await assert.rejects(second.request({ type: 'attach', sessionId: info.sessionId, instanceId: 'old' }), /stale/);
    await first.request({ type: 'input', ...info, data: 'owner-kept\n' });
    await waitFor(() => textOf(events, info).includes('INPUT:owner-kept'));
  } finally { await t.cleanup(); }
});

test('M1 fix: control transfer names the affected instance and detach preserves the PTY', async () => {
  const t = await setup();
  try {
    const first = await t.connect();
    const second = await t.connect();
    const events = watch(first);
    const a = await create(first);
    const b = await create(first);
    await first.request({ type: 'attach', ...a });
    await catchSession(first, events, a);
    await first.request({ type: 'attach', ...b });
    await catchSession(first, events, b);
    await second.request({ type: 'attach', ...a });
    const transferred = events.findLast(event => event.type === 'resync');
    assert.ok(transferred && 'sessionId' in transferred);
    assert.equal(transferred.sessionId, a.sessionId);
    assert.equal(transferred.instanceId, a.instanceId);
    await first.request({ type: 'detach', ...b });
    assert.equal((await sessionOf(first, b)).alive, true);
    await assert.rejects(first.request({ type: 'input', ...b, data: 'detached\n' }), /not ready/);
    await first.request({ type: 'attach', ...b });
    await catchSession(first, events, b);
    await first.request({ type: 'input', ...b, data: 'reattached\n' });
    await waitFor(() => textOf(events, b).includes('INPUT:reattached'));
  } finally { await t.cleanup(); }
});

test('M1 fix: two PTYs resuming the same agent keep prompts and read positions separate', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const a = await create(client);
    const b = await create(client);
    await waitFor(async () => (await listAll(client)).every(info => info.foreground?.provider === 'claude'));
    for (const [info, prompt] of [[a, 'only-A'], [b, 'only-B']] as const) {
      await client.request({ type: 'hook', event: hook(info, `start-${info.sessionId}`, 'SessionStart') });
      await client.request({ type: 'hook', event: hook(info, `prompt-${info.sessionId}`, 'UserPromptSubmit', { prompt }) });
    }
    let av = await sessionOf(client, a);
    let bv = await sessionOf(client, b);
    assert.deepEqual(av.history.records.map(r => r.prompt), ['only-A']);
    assert.deepEqual(bv.history.records.map(r => r.prompt), ['only-B']);
    await client.request({ type: 'read', ...a, seq: av.history.records.at(-1)!.seq });
    await client.request({ type: 'hook', event: hook(b, 'refresh-B', 'Stop') });
    av = await sessionOf(client, a); bv = await sessionOf(client, b);
    assert.equal(av.history.unread, 0);
    assert.equal(bv.history.unread, 1);
  } finally { await t.cleanup(); }
});

test('M1 fix: shared transcript usage is hidden while two PTYs own the conversation and returns after exit', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const file = path.join(t.dir, 'rollout-2026-11-15T00-00-00-00000000-0000-4000-8000-000000000001.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'shared-agent' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: 1000, output_tokens: 200, cached_input_tokens: 300, total_tokens: 1200,
      } } } }) + '\n');
    const env = { TARMAC_TEST_PROVIDER: 'codex', TARMAC_TEST_TRANSCRIPT: file };
    const a = await create(client, { env });
    await waitFor(async () => (await sessionOf(client, a)).usage?.totalTokens === 1200);
    const b = await create(client, { env });
    await waitFor(async () => {
      const listed = await listAll(client);
      return listed.every(info => !info.usage && info.usageError?.includes('多个终端'));
    });
    await client.request({ type: 'close', ...b });
    await waitFor(async () => (await sessionOf(client, a)).usage?.totalTokens === 1200);
  } finally { await t.cleanup(); }
});

test('M1 fix: acknowledged concurrent creates are all present in the registry', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const infos = await Promise.all(Array.from({ length: 8 }, () => create(client)));
    const saved = JSON.parse(await readFile(path.join(t.dir, 'registry.json'), 'utf8'));
    assert.deepEqual(new Set(saved.sessions.map((entry: { session: SessionInfo }) => entry.session.sessionId)), new Set(infos.map(info => info.sessionId)));
    await Promise.all(infos.map(info => client.request({ type: 'close', ...info })));
    await waitFor(async () => (await listAll(client)).every(info => !info.alive));
    await t.daemon.persist();
    const ended = JSON.parse(await readFile(path.join(t.dir, 'registry.json'), 'utf8'));
    assert.equal(ended.sessions.length, 8);
    assert.ok(ended.sessions.every((entry: { session: SessionInfo }) => !entry.session.alive));
  } finally { await t.cleanup(); }
});

function sessionEvents(events: ServerEvent[], identity: { sessionId: string }): ServerEvent[] {
  return events.filter(event => 'sessionId' in event && event.sessionId === identity.sessionId);
}
function textOf(events: ServerEvent[], identity: { sessionId: string }): string {
  return sessionEvents(events, identity)
    .flatMap(event => event.type === 'output' || event.type === 'snapshot' ? [Buffer.from(event.data, 'base64').toString()] : [])
    .join('');
}
async function catchSession(client: Client, events: ServerEvent[], identity: { sessionId: string; instanceId: string }): Promise<void> {
  await waitFor(() => sessionEvents(events, identity).some(event => event.type === 'snapshot'));
  const deadline = Date.now() + 5000;
  for (;;) {
    const mine = sessionEvents(events, identity);
    const snapshot = mine.findLast(event => event.type === 'snapshot');
    assert.ok(snapshot?.type === 'snapshot');
    const seq = Math.max(snapshot.seq, ...mine.flatMap(event => event.type === 'output' || event.type === 'resize' ? [event.seq] : []));
    await client.request({ type: 'ack', sessionId: identity.sessionId, instanceId: identity.instanceId, seq });
    if (seq >= snapshot.target) return;
    if (Date.now() > deadline) throw new Error('session catch-up timed out');
    await delay(20);
  }
}

test('M1: three real PTYs run in parallel with isolated input, resize, queries and PIDs', async () => {
  const t = await setup();
  try {
    const clients = [await t.connect(), await t.connect(), await t.connect()];
    const watches = clients.map(client => watch(client));
    const a = await create(clients[0]);
    const b = await create(clients[1]);
    const c = await create(clients[2], { cwd: t.dir });
    assert.notDeepEqual(new Set([a.pid, b.pid, c.pid]).size, 2);
    assert.equal(new Set([a.pid, b.pid, c.pid]).size, 3);
    assert.equal(a.cwd, base);
    assert.equal(b.cwd, base);
    assert.equal(c.cwd, t.dir);
    for (const [index, info] of [a, b, c].entries()) {
      await clients[index].request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
      await catchSession(clients[index], watches[index], info);
    }
    await clients[0].request({ type: 'input', ...a, data: 'mark-A\n' });
    await clients[1].request({ type: 'input', ...b, data: 'mark-B\n' });
    await clients[2].request({ type: 'input', ...c, data: 'mark-C\n' });
    await waitFor(() => textOf(watches[0], a).includes('INPUT:mark-A'));
    await waitFor(() => textOf(watches[1], b).includes('INPUT:mark-B'));
    await waitFor(() => textOf(watches[2], c).includes('INPUT:mark-C'));
    assert.ok(!textOf(watches[0], a).includes('mark-B') && !textOf(watches[0], a).includes('mark-C'));
    assert.ok(!textOf(watches[1], b).includes('mark-A'));
    await clients[0].request({ type: 'resize', ...a, cols: 90, rows: 28 });
    await clients[1].request({ type: 'resize', ...b, cols: 110, rows: 32 });
    await clients[2].request({ type: 'resize', ...c, cols: 120, rows: 36 });
    await waitFor(() => textOf(watches[0], a).includes('SIZE:90x28'));
    await waitFor(() => textOf(watches[1], b).includes('SIZE:110x32'));
    await waitFor(() => textOf(watches[2], c).includes('SIZE:120x36'));
    assert.ok(!textOf(watches[1], b).includes('SIZE:90x28'));
    const bBefore = textOf(watches[1], b).length;
    await clients[0].request({ type: 'input', ...a, data: 'query\n' });
    await waitFor(() => /\[\d+;\d+R/.test(textOf(watches[0], a)));
    await delay(100);
    assert.equal(textOf(watches[1], b).length, bBefore, 'terminal query reply stays on its own session');
    const listed = await listAll(clients[0]);
    assert.equal(listed.length, 3);
    assert.deepEqual(listed.map(item => item.sessionId), [a.sessionId, b.sessionId, c.sessionId]);
  } finally { await t.cleanup(); }
});

test('M1: failed create, unknown session and stale instance leave existing sessions untouched', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const events = watch(client);
    const info = await create(client);
    await client.request({ type: 'attach', ...info });
    await catchSession(client, events, info);
    await assert.rejects(create(client, { cwd: path.join(t.dir, 'missing-dir') }), /ENOENT|does not exist/);
    await assert.rejects(create(client, { cols: 1, rows: 24 }), /invalid create options/);
    const unknown = { sessionId: randomUUID(), instanceId: randomUUID() };
    await assert.rejects(client.request({ type: 'attach', ...unknown }), /stale/);
    await assert.rejects(client.request({ type: 'input', ...unknown, data: 'x\n' }), /stale/);
    await assert.rejects(client.request({ type: 'resize', ...unknown, cols: 80, rows: 24 }), /stale/);
    await assert.rejects(client.request({ type: 'input', sessionId: info.sessionId, instanceId: 'old', data: 'x\n' }), /stale/);
    assert.equal((await sessionOf(client, info)).alive, true);
    await client.request({ type: 'input', ...info, data: 'still-alive\n' });
    await waitFor(() => textOf(events, info).includes('INPUT:still-alive'));
    assert.equal((await listAll(client)).length, 1);
  } finally { await t.cleanup(); }
});

test('M1: duplicate close and one session exit do not affect other sessions', async () => {
  const t = await setup();
  try {
    const first = await t.connect();
    const second = await t.connect();
    const eventsA = watch(first);
    const eventsB = watch(second);
    const a = await create(first);
    const b = await create(second);
    await first.request({ type: 'attach', ...a });
    await catchSession(first, eventsA, a);
    await second.request({ type: 'attach', ...b });
    await catchSession(second, eventsB, b);
    const pidB = (await sessionOf(second, b)).pid;
    await first.request({ type: 'close', ...a });
    await waitFor(async () => !(await sessionOf(first, a)).alive);
    await first.request({ type: 'close', ...a });
    const listed = await listAll(first);
    assert.equal(listed.find(item => item.sessionId === a.sessionId)?.alive, false);
    assert.equal(listed.find(item => item.sessionId === b.sessionId)?.alive, true);
    await second.request({ type: 'input', ...b, data: 'b-survives\n' });
    await waitFor(() => textOf(eventsB, b).includes('INPUT:b-survives'));
    assert.equal((await sessionOf(second, b)).pid, pidB);
  } finally { await t.cleanup(); }
});

test('M1: input control is per PTY and one connection can hold several sessions', async () => {
  const t = await setup();
  try {
    const c1 = await t.connect();
    const c2 = await t.connect();
    const e1 = watch(c1);
    const e2 = watch(c2);
    const a = await create(c1);
    const b = await create(c1);
    await c1.request({ type: 'attach', ...a });
    await catchSession(c1, e1, a);
    await c1.request({ type: 'attach', ...b });
    await catchSession(c1, e1, b);
    await c2.request({ type: 'attach', ...a });
    await catchSession(c2, e2, a);
    await waitFor(() => e1.some(event => event.type === 'resync' && event.reason.includes('control transferred')));
    await assert.rejects(c1.request({ type: 'input', ...a, data: 'late\n' }), /not ready/);
    await c1.request({ type: 'input', ...b, data: 'b-control-kept\n' });
    await waitFor(() => textOf(e1, b).includes('INPUT:b-control-kept'));
    await c2.request({ type: 'input', ...a, data: 'a-taken-over\n' });
    await waitFor(() => textOf(e2, a).includes('INPUT:a-taken-over'));
  } finally { await t.cleanup(); }
});

test('M1: a terminal parse failure ends only the failing session', async () => {
  const t = await setup();
  try {
    const ca = await t.connect();
    const cb = await t.connect();
    const ea = watch(ca);
    const eb = watch(cb);
    const a = await create(ca);
    const b = await create(cb);
    await ca.request({ type: 'attach', ...a });
    await catchSession(ca, ea, a);
    await cb.request({ type: 'attach', ...b });
    await catchSession(cb, eb, b);
    await ca.request({ type: 'input', ...a, data: 'badseq\n' });
    await waitFor(async () => {
      const view = await sessionOf(ca, a);
      return !view.alive && Boolean(view.error);
    });
    assert.equal((await sessionOf(cb, b)).alive, true);
    await cb.request({ type: 'input', ...b, data: 'b-continues\n' });
    await waitFor(() => textOf(eb, b).includes('INPUT:b-continues'));
  } finally { await t.cleanup(); }
});

test('M1: v1 registry migrates with input records while unknown and corrupt registries are preserved', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'mig-'));
  const v1Session = {
    sessionId: randomUUID(), instanceId: randomUUID(), pid: 4242, command: '/bin/sh', args: ['-l'],
    cwd: dir, cols: 80, rows: 24, alive: true, agent: null,
    hooks: { configured: true, verified: true }, history: { records: [], readSeq: 0, unread: 0 },
  };
  const entry = { v: 1, eventId: randomUUID(), provider: 'claude', agentSessionId: 'agent-session',
    eventName: 'UserPromptSubmit', at: new Date().toISOString(), seq: 1, prompt: 'migrated prompt 中文' };
  await writeFile(path.join(dir, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'read.json'), JSON.stringify({ v: 1, read: [] }) + '\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'registry.json'),
    JSON.stringify({ v: 1, session: v1Session, selectedHistory: { provider: 'claude', id: 'agent-session' } }) + '\n', { mode: 0o600 });
  const daemon = new Daemon(dir);
  let client: Client | undefined;
  try {
    await daemon.start();
    client = await Client.connect(daemon.socketPath);
    const listed = await listAll(client);
    assert.equal(listed.length, 1);
    const migrated = listed[0];
    assert.equal(migrated.sessionId, v1Session.sessionId);
    assert.equal(migrated.alive, false, 'old runs are never marked alive');
    assert.equal(migrated.agent, null);
    assert.equal(migrated.hooks.verified, false);
    assert.equal(migrated.cwd, dir);
    assert.equal(migrated.history.records[0]?.prompt, 'migrated prompt 中文');
    assert.equal(migrated.history.unread, 1);
    await assert.rejects(client.request({ type: 'attach', sessionId: migrated.sessionId, instanceId: migrated.instanceId }), /persisted/);
    const persisted = JSON.parse(await readFile(path.join(dir, 'registry.json'), 'utf8'));
    assert.equal(persisted.v, VERSION);
    assert.equal(persisted.sessions[0].session.sessionId, v1Session.sessionId);
  } finally {
    client?.close();
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }

  const emptyDir = await mkdtemp(path.join(base, 'mig-empty-'));
  const empty = new Daemon(emptyDir);
  try {
    await writeFile(path.join(emptyDir, 'registry.json'), JSON.stringify({ v: 1, session: null }));
    await empty.start();
    assert.deepEqual(empty.list(), []);
    assert.deepEqual(JSON.parse(await readFile(path.join(emptyDir, 'registry.json'), 'utf8')), { v: VERSION, sessions: [] });
  } finally { await empty.stop(); await rm(emptyDir, { recursive: true, force: true }); }

  for (const content of ['{ "v": 99, "sessions": [] }', 'broken-not-json']) {
    const other = await mkdtemp(path.join(base, 'mig-bad-'));
    const file = path.join(other, 'registry.json');
    await writeFile(file, content + '\n', { mode: 0o600 });
    const rejected = new Daemon(other);
    await assert.rejects(rejected.start(), /registry\.json/);
    assert.equal(await readFile(file, 'utf8'), content + '\n', 'unsupported or corrupt registry is never overwritten');
    await rm(other, { recursive: true, force: true });
  }
});

test('M1: close ends one session but shutdown stops the whole daemon and all PTYs', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const a = await create(client);
    const b = await create(client, { cwd: t.dir });
    await client.request({ type: 'close', ...a });
    await waitFor(async () => !(await sessionOf(client, a)).alive);
    assert.equal((await sessionOf(client, b)).alive, true);
    await client.request({ type: 'shutdown' });
    await waitFor(async () => {
      try { await Client.connect(t.daemon.socketPath, 100); return false; }
      catch { return true; }
    });
    const restarted = new Daemon(t.dir);
    await restarted.start();
    try {
      const next = await Client.connect(restarted.socketPath);
      try {
        const listed = await listAll(next);
        assert.deepEqual(listed.map(item => item.alive), [false, false]);
        assert.equal(listed.length, 2);
      } finally { next.close(); }
    } finally { await restarted.stop(); }
  } finally { await t.cleanup(); }
});

// ---- External control (`tarmac ctl`, docs/tarmac-ctl.md) -------------------------------------

const fixture = path.join(root, 'packages/daemon/test/fake-agent.mjs');
async function remoteList(client: Client): Promise<RemoteSession[]> { return client.request<RemoteSession[]>({ type: 'remote-list' }); }
async function remoteScreen(client: Client, id: Identity, lines = 30, join = true): Promise<string> {
  return (await client.request<{ text: string }>({ type: 'remote-screen', ...id, lines, join })).text;
}
async function remoteCreate(client: Client): Promise<Identity & { pid: number }> {
  // `fixture` is no provider name, so no user hook configuration is inspected.
  return client.request({ type: 'remote-create', cwd: base, command: process.execPath, args: [fixture, 'fixture'], origin: 'my-bot' });
}
// Agent's foreground PID as `ctl list` reports it, once the probe sees the fixture.
async function agentPid(client: Client, id: Identity): Promise<number> {
  let found: number | undefined;
  await waitFor(async () => {
    found = (await remoteList(client)).find(s => s.sessionId === id.sessionId)?.foreground?.pid;
    return found !== undefined && (await remoteScreen(client, id)).includes('READY:');
  });
  return found!;
}
// Bytes the fixture received in hex mode: every HEX line on screen, concatenated.
async function received(client: Client, id: Identity): Promise<string> {
  return [...(await remoteScreen(client, id, 2000, false)).matchAll(/^HEX:([0-9a-f]*)$/gm)].map(m => m[1]).join('');
}
async function written(client: Client, id: Identity, write: () => Promise<unknown>): Promise<string> {
  const before = await received(client, id);
  await write();
  let after = before;
  await waitFor(async () => (after = await received(client, id)) !== before);
  await delay(100); // A split chunk would arrive right after the first.
  return Buffer.from((await received(client, id)).slice(before.length), 'hex').toString('latin1');
}

test('ctl list reports the foreground PID and origin; origin survives a daemon restart', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const created = await remoteCreate(client);
    assert.match(created.sessionId, /^[^:]+$/);
    assert.match(created.instanceId, /^[^:]+$/);
    const pid = await agentPid(client, created);
    const listed = (await remoteList(client)).find(s => s.sessionId === created.sessionId);
    assert.deepEqual({ ...listed, foreground: { pid: listed?.foreground?.pid } }, { sessionId: created.sessionId,
      instanceId: created.instanceId, pid: created.pid, alive: true, cwd: base, origin: 'my-bot', foreground: { pid } });
    assert.equal((await sessionOf(client, created)).origin, 'my-bot', 'the App sees the new session too');
    await assert.rejects(client.request({ type: 'remote-create', cwd: base, command: process.execPath, args: [], origin: 'Bad!' }), /invalid remote request/);
    await assert.rejects(client.request({ type: 'remote-create', cwd: path.join(base, 'missing'), command: process.execPath, args: [] }), /invalid remote request/);
    await t.daemon.stop();
    const restarted = new Daemon(t.dir);
    await restarted.start();
    try {
      const next = await Client.connect(restarted.socketPath);
      try {
        const kept = (await remoteList(next)).find(s => s.sessionId === created.sessionId);
        assert.deepEqual([kept?.alive, kept?.origin, kept?.foreground], [false, 'my-bot', null]);
        await assert.rejects(remoteScreen(next, created), /stale/);
      } finally { next.close(); }
    } finally { await restarted.stop(); }
  } finally { await t.cleanup(); }
});

test('ctl text and key reach the PTY while the App keeps control; stale and rejected writes write nothing', async () => {
  const t = await setup();
  try {
    const app = await t.connect();
    const events = watch(app);
    const info = await create(app, { env: { CLAUDE_CONFIG_DIR: path.join(base, 'isolated-claude'), TARMAC_TEST_PROVIDER: 'fixture' } });
    await app.request({ type: 'attach', sessionId: info.sessionId, instanceId: info.instanceId });
    await catchUp(app, events, info);
    const remote = await t.connect();
    const pid = await agentPid(remote, info);
    await assert.rejects(remote.request({ type: 'remote-text', ...info, expectPid: pid + 100_000, text: 'LEAK-REJECTED' }), /not in the foreground/);
    await assert.rejects(remote.request({ type: 'remote-text', sessionId: info.sessionId, instanceId: 'old', expectPid: pid, text: 'LEAK-STALE' }), /stale/);
    await assert.rejects(remote.request({ type: 'remote-key', ...info, expectPid: pid + 100_000, keys: ['Enter'] }), /not in the foreground/);
    await remote.request({ type: 'remote-text', ...info, expectPid: pid, text: '外部' });
    await remote.request({ type: 'remote-key', ...info, expectPid: pid, keys: ['Enter'] });
    await waitFor(() => terminalText(events).includes('INPUT:外部'));
    assert.doesNotMatch(terminalText(events), /LEAK/, 'a refused write puts no byte into the PTY');
    assert.equal(events.some(event => event.type === 'resync'), false, 'the App connection keeps control');
    await app.request({ type: 'input', sessionId: info.sessionId, instanceId: info.instanceId, data: 'app\r' });
    await waitFor(() => terminalText(events).includes('INPUT:app'));
    await assert.rejects(remote.request({ type: 'remote-text', ...info, expectPid: pid, text: '' }), /invalid remote request/);
    await assert.rejects(remote.request({ type: 'remote-close', ...info, expectPid: pid + 100_000 }), /not in the foreground/);
    await remote.request({ type: 'remote-close', ...info, expectPid: pid });
    await waitFor(async () => !(await sessionOf(app, info)).alive);
    await assert.rejects(remote.request({ type: 'remote-key', ...info, expectPid: pid, keys: ['Enter'] }), /stale/);
  } finally { await t.cleanup(); }
});

test('ctl writes follow bracketed paste and cursor key modes; an unknown key writes nothing', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const line = async (id: Identity, pid: number, text: string, marker: string) => {
      await client.request({ type: 'remote-text', ...id, expectPid: pid, text });
      await client.request({ type: 'remote-key', ...id, expectPid: pid, keys: ['Enter'] });
      await waitFor(async () => (await remoteScreen(client, id)).includes(marker));
    };
    const plain = await remoteCreate(client);
    const plainPid = await agentPid(client, plain);
    await line(plain, plainPid, 'hex', 'HEX-ON');
    assert.equal(await written(client, plain, () => client.request({ type: 'remote-text', ...plain, expectPid: plainPid, text: 'a\x1b[201~b' })), 'a\x1b[201~b');
    assert.equal(await written(client, plain, () => client.request({ type: 'remote-key', ...plain, expectPid: plainPid, keys: ['Up', 'Down', 'Enter'] })), '\x1b[A\x1b[B\r');
    await assert.rejects(client.request({ type: 'remote-key', ...plain, expectPid: plainPid, keys: ['Up', 'Bogus' as 'Up'] }), /invalid remote request/);
    assert.equal(await written(client, plain, () => client.request({ type: 'remote-key', ...plain, expectPid: plainPid, keys: ['Escape'] })), '\x1b',
      'nothing of the refused request arrived before the next key');

    const modes = await remoteCreate(client);
    const modesPid = await agentPid(client, modes);
    await line(modes, modesPid, 'appcursor on', 'APPCURSOR-ON');
    await line(modes, modesPid, 'paste on', 'PASTE-ON');
    await line(modes, modesPid, 'hex', 'HEX-ON');
    assert.equal(await written(client, modes, () => client.request({ type: 'remote-text', ...modes, expectPid: modesPid, text: 'x\x1b[201~y' })), '\x1b[200~xy\x1b[201~');
    assert.equal(await written(client, modes, () => client.request({ type: 'remote-key', ...modes, expectPid: modesPid, keys: ['Up', 'Down'] })), '\x1bOA\x1bOB');
  } finally { await t.cleanup(); }
});

test('attach with ifFree leaves a session another connection controls, except to the same App instance', async () => {
  const t = await setup();
  try {
    const first = await t.connect();
    const second = await t.connect();
    const info = await create(first);
    const identity = { sessionId: info.sessionId, instanceId: info.instanceId };
    await first.request({ type: 'desktop-register', appId: 'app-a' });
    await first.request({ type: 'attach', ifFree: true, ...identity });
    const events = watch(first);
    await assert.rejects(second.request({ type: 'attach', ifFree: true, ...identity }), new RegExp(SESSION_BUSY));
    await delay(50);
    assert.ok(!events.some(event => event.type === 'resync'), 'the owner keeps control and sees no resync');
    // The same App reconnecting (its earlier link not yet gone) is not another window.
    const again = await t.connect();
    await again.request({ type: 'desktop-register', appId: 'app-a' });
    await again.request({ type: 'attach', ifFree: true, ...identity });
    await waitFor(() => events.some(event => event.type === 'resync'));
    // An explicit takeover still moves control, and a closed owner frees the session.
    await second.request({ type: 'attach', ...identity });
    second.close();
    await waitFor(async () => { try { await first.request({ type: 'attach', ifFree: true, ...identity }); return true; } catch { return false; } });
  } finally { await t.cleanup(); }
});

// ---- Pasted images (`upload`) -----------------------------------------------------------------
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function uploadPart(identity: Identity, uploadId: string, part: number, parts: number, data: Buffer) {
  return { type: 'upload' as const, ...identity, uploadId, kind: 'png' as const, part, parts, data: data.toString('base64') };
}
const exists = (file: string) => stat(file).then(() => true, () => false);

test('an image uploaded in parts is saved under its session and removed when the process exits', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const events = watch(client);
    const info = await create(client);
    const identity = { sessionId: info.sessionId, instanceId: info.instanceId };
    const first = Buffer.concat([PNG, Buffer.alloc(UPLOAD_PART_BYTES - PNG.length, 1)]);
    const second = Buffer.from('tail');
    assert.equal(await client.request(uploadPart(identity, 'a'.repeat(32), 0, 2, first)), null);
    const saved = await client.request<string>(uploadPart(identity, 'a'.repeat(32), 1, 2, second));
    assert.equal(path.dirname(saved), path.join(t.dir, 'uploads', info.sessionId));
    assert.match(path.basename(saved), /^\d{8}-\d{6}-aaaaaaaa\.png$/);
    assert.deepEqual(await readFile(saved), Buffer.concat([first, second]));
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(saved))).mode & 0o777, 0o700);
    await client.request({ type: 'attach', ...identity });
    await catchUp(client, events, info);
    await client.request({ type: 'input', ...identity, data: 'quit\n' });
    await waitFor(async () => !(await sessionOf(client, info)).alive);
    await waitFor(async () => !(await exists(path.dirname(saved))));
    await assert.rejects(client.request(uploadPart(identity, 'b'.repeat(32), 0, 1, PNG)), /process has exited/);
  } finally { await t.cleanup(); }
});

test('uploads out of order, malformed, too large or for a stale instance are refused', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const info = await create(client);
    const identity = { sessionId: info.sessionId, instanceId: info.instanceId };
    await assert.rejects(client.request(uploadPart(identity, 'c'.repeat(32), 1, 2, PNG)), /out of order/);
    await client.request(uploadPart(identity, 'c'.repeat(32), 0, 2, PNG));
    await assert.rejects(client.request(uploadPart(identity, 'c'.repeat(32), 0, 2, PNG)), /already started/);
    await assert.rejects(client.request({ ...uploadPart(identity, 'd'.repeat(32), 0, 1, PNG), kind: 'bmp' as never }), /invalid upload/);
    await assert.rejects(client.request(uploadPart(identity, 'not-hex', 0, 1, PNG)), /invalid upload/);
    await assert.rejects(client.request({ ...uploadPart(identity, 'e'.repeat(32), 0, 1, PNG), data: 'not base64!' }), /invalid upload/);
    await assert.rejects(client.request(uploadPart(identity, 'f'.repeat(32), 0, 1, Buffer.alloc(UPLOAD_PART_BYTES + 1))), /invalid upload/);
    const tooMany = Math.ceil(UPLOAD_MAX_BYTES / UPLOAD_PART_BYTES) + 1;
    await assert.rejects(client.request(uploadPart(identity, '1'.repeat(32), 0, tooMany, PNG)), /invalid upload/);
    await assert.rejects(client.request(uploadPart({ ...identity, instanceId: randomUUID() }, '2'.repeat(32), 0, 1, PNG)), /stale/);
  } finally { await t.cleanup(); }
});

test('a starting daemon removes images an earlier daemon left behind', async () => {
  const t = await setup();
  try {
    const client = await t.connect();
    const info = await create(client);
    await client.request(uploadPart({ sessionId: info.sessionId, instanceId: info.instanceId }, '3'.repeat(32), 0, 1, PNG));
    await t.daemon.stop();
    const again = new Daemon(t.dir);
    await again.start();
    try { assert.equal(await exists(path.join(t.dir, 'uploads')), false); }
    finally { await again.stop(); }
  } finally { await t.cleanup(); }
});
