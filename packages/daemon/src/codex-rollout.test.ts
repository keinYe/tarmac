import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { bindRollouts, codexApprovalOnScreen, parseRolloutMeta, parseRolloutPrompt, parseRolloutTurn, rolloutActivity,
  RolloutIndex, START_AFTER_MS } from './codex-rollout.ts';
import type { RolloutBinding, RolloutFile, RolloutRun } from './codex-rollout.ts';

// Synthetic fixtures modelled on Codex 0.169 rollout rows; not recordings.
const home = '/codex-home';
const cwd = '/project';
const meta = (id: string, at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(),
  type: 'session_meta', payload: { id, timestamp: new Date(at).toISOString(), cwd, originator: 'codex-tui', source: 'vscode', ...extra } });
const turn = (type: string, at: number, id: string, trigger = 'user') => JSON.stringify({ timestamp: new Date(at).toISOString(),
  type: 'event_msg', payload: { type, turn_id: id, ...(type === 'task_started' ? { turn_attribution: { turn_trigger: trigger } } : {}) } });
const file = (name: string, createdAt: number, turns: RolloutFile['turns'] = [], where = cwd): RolloutFile =>
  ({ home, file: `/f/${name}`, id: name, cwd: where, createdAt, turns, prompts: [] });
// Codex 0.170 shape: typed input carries retained_source; injected context does not.
const userMessage = (at: number, text: string, messageId?: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  timestamp: new Date(at).toISOString(), type: 'response_item',
  metadata: messageId ? { retained_source: { id: { message_id: messageId, role: 'user' }, complete: true, ...extra } } : { client_authored: false },
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const run = (key: string, startedAt: number, enters: number[] = [], pid = 1): RolloutRun =>
  ({ key, home, pid, cwd, startedAt, enters });
const started = (at: number, id = `t${at}`) => ({ kind: 'started' as const, at, id, user: true });
const bound = (map: Map<string, RolloutBinding>) => Object.fromEntries([...map].map(([key, value]) => [key, value.file]));

test('session_meta accepts top-level TUI threads and rejects subagents, forks and other originators', () => {
  assert.equal(parseRolloutMeta(meta('a', 1000), home, '/f/a')?.id, 'a');
  assert.equal(parseRolloutMeta(meta('g', 1000, { source: { subagent: { other: 'guardian' } } }), home, '/f/g'), undefined);
  assert.equal(parseRolloutMeta(meta('p', 1000, { parent_thread_id: 'a' }), home, '/f/p'), undefined);
  assert.equal(parseRolloutMeta(meta('e', 1000, { originator: 'codex_exec' }), home, '/f/e'), undefined);
  assert.equal(parseRolloutMeta(meta('r', 1000, { cwd: 'relative' }), home, '/f/r'), undefined);
  assert.equal(parseRolloutMeta('{bad', home, '/f/x'), undefined);
});

test('turn rows keep ids and mark non-user triggers', () => {
  assert.deepEqual(parseRolloutTurn(turn('task_started', 5000, 'u1')), { kind: 'started', at: 5000, id: 'u1', user: true });
  assert.equal(parseRolloutTurn(turn('task_started', 5000, 's1', 'system'))?.user, false);
  assert.equal(parseRolloutTurn(turn('task_complete', 6000, 'u1'))?.kind, 'complete');
  assert.equal(parseRolloutTurn(turn('turn_aborted', 6000, 'u1'))?.kind, 'aborted');
  assert.equal(parseRolloutTurn(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })), undefined);
});

test('user prompts need retained_source and a message id; injected context, partial and empty messages are skipped', () => {
  assert.deepEqual(parseRolloutPrompt(userMessage(5000, '看下项目进度', 'm1')), { id: 'm1', at: 5000, text: '看下项目进度' });
  assert.equal(parseRolloutPrompt(userMessage(5000, '# AGENTS.md instructions for /project')), undefined);
  assert.equal(parseRolloutPrompt(userMessage(5000, 'draft', 'm2', { complete: false })), undefined);
  assert.equal(parseRolloutPrompt(userMessage(5000, '  \n ', 'm3')), undefined);
  const assistant = JSON.parse(userMessage(5000, 'reply', 'm4'));
  assistant.payload.role = 'assistant';
  assert.equal(parseRolloutPrompt(JSON.stringify(assistant)), undefined);
  const parts = JSON.parse(userMessage(5000, 'first', 'm5'));
  parts.payload.content.push({ type: 'input_image', image_url: 'data:' }, { type: 'input_text', text: 'second' });
  assert.equal(parseRolloutPrompt(JSON.stringify(parts))?.text, 'first\nsecond');
  assert.equal(parseRolloutPrompt('{"type":"response_item","retained_source":'), undefined);
});

test('start evidence binds only after its window closes and only when unique', () => {
  const runs = [run('a', 10_000)];
  const own = file('own', 11_000);
  assert.deepEqual(bound(bindRollouts(runs, [own], new Map(), 10_000 + START_AFTER_MS)), {});
  assert.deepEqual(bound(bindRollouts(runs, [own], new Map(), 10_001 + START_AFTER_MS)), { a: '/f/own' });
  // A terminal outside Tarmac started Codex in the same directory meanwhile.
  assert.deepEqual(bound(bindRollouts(runs, [own, file('external', 12_000)], new Map(), 90_000)), {});
  // Other directories and files created before the process are not candidates.
  assert.deepEqual(bound(bindRollouts(runs, [own, file('elsewhere', 11_000, [], '/other'), file('old', 7000)], new Map(), 90_000)),
    { a: '/f/own' });
  // Two Tarmac runs whose windows both contain the file cannot split start evidence.
  assert.deepEqual(bound(bindRollouts([run('a', 10_000), run('b', 10_500, [], 2)], [own], new Map(), 90_000)), {});
  // A run that started too late for the file to be its own is no rival.
  assert.deepEqual(bound(bindRollouts([run('a', 10_000), run('b', 20_000, [], 2)], [own], new Map(), 90_000)), { a: '/f/own' });
});

test('submit evidence disambiguates same-directory runs and external terminals', () => {
  const f1 = file('f1', 10_500, [started(30_200)]);
  const f2 = file('f2', 20_500, [started(40_300)]);
  const external = file('external', 21_000, [started(36_000)]);
  const runs = [run('a', 10_000, [30_000]), run('b', 20_000, [40_000], 2)];
  assert.deepEqual(bound(bindRollouts(runs, [f1, f2, external], new Map(), 41_000)), { a: '/f/f1', b: '/f/f2' });
  // Both PTYs pressed Enter in the same window: one start cannot be attributed.
  const both = [run('a', 10_000, [30_000]), run('b', 20_000, [30_100], 2)];
  assert.deepEqual(bound(bindRollouts(both, [f1], new Map(), 31_000)), {});
  // Two files started after one Enter are ambiguous as well.
  assert.deepEqual(bound(bindRollouts([run('a', 10_000, [30_000])], [f1, file('x', 25_000, [started(30_400)])], new Map(), 31_000)), {});
  // A start outside the window or triggered by the system is not evidence.
  assert.deepEqual(bound(bindRollouts([run('a', 10_000, [30_000])], [file('late', 25_000, [started(36_000)])], new Map(), 37_000)), {});
  assert.deepEqual(bound(bindRollouts([run('a', 10_000, [30_000])],
    [file('sys', 25_000, [{ ...started(30_200), user: false }])], new Map(), 31_000)), {});
});

test('resume, /new, claimed files and process changes', () => {
  const resumed = file('resumed', 1000, [started(30_300, 'r1'), { kind: 'complete', at: 40_000, id: 'r1', user: true }]);
  const first = bindRollouts([run('a', 10_000, [30_000])], [resumed], new Map(), 31_000);
  assert.deepEqual(bound(first), { a: '/f/resumed' });
  assert.equal(first.get('a')?.from, 30_000);
  // /new: a later Enter starts a different file, which replaces the binding.
  const fresh = file('fresh', 50_000, [started(60_200)]);
  const switched = bindRollouts([run('a', 10_000, [30_000, 60_000])], [resumed, fresh], first, 61_000);
  assert.deepEqual(bound(switched), { a: '/f/fresh' });
  // A file bound to one run is never offered to another.
  const other = bindRollouts([run('a', 10_000, [30_000, 60_000]), run('b', 55_000, [70_000], 2)],
    [resumed, file('fresh', 50_000, [started(60_200), started(70_100)])], switched, 71_000);
  assert.deepEqual(bound(other), { a: '/f/fresh' });
  // A new process in the same PTY starts without the old binding.
  assert.deepEqual(bound(bindRollouts([run('a', 80_000, [], 9)], [resumed, fresh], switched, 81_000)), {});
});

test('an Enter inside the bound thread\'s open turn never moves the binding to another thread', () => {
  // Reproduces a full-suite failure: an approval-menu Enter landed in the same
  // millisecond as an external terminal's turn start in the same directory.
  const own = file('own', 10_500, [started(30_000, 'u1')]);
  const external = file('external', 10_600, [started(31_000, 'x1')]);
  const first = bindRollouts([run('a', 10_000, [30_000])], [own, file('external', 10_600)], new Map(), 30_500);
  assert.deepEqual(bound(first), { a: '/f/own' });
  const menu = bindRollouts([run('a', 10_000, [30_000, 31_000, 31_001])], [own, external], first, 32_000);
  assert.deepEqual(bound(menu), { a: '/f/own' });
  // Once the own turn has completed, an idle Enter may again move it (/new).
  own.turns.push({ kind: 'complete', at: 33_000, id: 'u1', user: true });
  const fresh = file('fresh', 33_500, [started(34_100, 'n1')]);
  assert.deepEqual(bound(bindRollouts([run('a', 10_000, [30_000, 34_000])], [own, external, fresh], menu, 35_000)), { a: '/f/fresh' });
});

test('activity ignores history before the binding point and pairs ends with their start', () => {
  const f = file('f', 0, [started(100, 'old'), { kind: 'complete', at: 200, id: 'old', user: true },
    started(1000, 'u1')]);
  assert.equal(rolloutActivity(f, 500).activity, 'working');
  assert.equal(rolloutActivity(f, 5000).activity, 'running');
  f.turns.push({ kind: 'complete', at: 1100, id: 'other', user: true });
  assert.equal(rolloutActivity(f, 500).activity, 'working');
  f.turns.push({ kind: 'complete', at: 1200, id: 'u1', user: true });
  assert.equal(rolloutActivity(f, 500).activity, 'waiting');
  f.turns.push(started(1300, 'u2'), { kind: 'aborted', at: 1400, id: 'u2', user: true });
  assert.deepEqual(rolloutActivity(f, 500), { activity: 'running', reason: 'turn_interrupted', turnId: 'u2' });
});

test('approval needs a Codex question and a Yes/No option near the bottom', () => {
  const menu = ['', '  Would you like to run the following command?', '  $ rm -rf build', '',
    '› 1. Yes, just this once', '  2. Yes, and don\'t ask again for this command in this session',
    '  3. No, and tell Codex what to do differently'];
  assert.equal(codexApprovalOnScreen(menu), true);
  assert.equal(codexApprovalOnScreen(['• The prompt says: Would you like to run the following command?', '› ']), false);
  assert.equal(codexApprovalOnScreen(['Yes, just this once']), false);
  assert.equal(codexApprovalOnScreen([...menu, ...Array(25).fill('later output')]), false);
});

test('index reads metadata, tails turns incrementally and skips old history of resumed files', async () => {
  const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'rollout-'));
  try {
    const now = Date.now();
    const date = new Date(now);
    const day = path.join(dir, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'));
    await mkdir(day, { recursive: true });
    const fresh = path.join(day, 'rollout-fresh.jsonl');
    const old = path.join(day, 'rollout-old.jsonl');
    const guardian = path.join(day, 'rollout-guardian.jsonl');
    await writeFile(fresh, [meta('fresh', now - 1000), userMessage(now - 600, 'hello', 'm1'),
      turn('task_started', now - 500, 'u1')].join('\n') + '\n');
    await writeFile(old, [meta('old', now - 3_600_000), userMessage(now - 3_000_100, 'history', 'h0'),
      turn('task_started', now - 3_000_000, 'h1')].join('\n') + '\n');
    await writeFile(guardian, meta('guardian', now, { source: { subagent: { other: 'guardian' } } }) + '\n');
    const index = new RolloutIndex(dir);
    const first = await index.refresh(now, new Set());
    assert.deepEqual(first.map(f => f.id).sort(), ['fresh', 'old']);
    assert.equal(first.find(f => f.id === 'fresh')?.turns.length, 1);
    assert.equal(first.find(f => f.id === 'old')?.turns.length, 0, 'resumed history is not replayed');
    assert.deepEqual(first.find(f => f.id === 'fresh')?.prompts.map(p => p.text), ['hello']);
    assert.deepEqual(first.find(f => f.id === 'old')?.prompts, [], 'resumed prompts are not replayed');
    // A compaction rewrite repeats a message id; it is kept once.
    await appendFile(fresh, userMessage(now - 600, 'hello', 'm1') + '\n');
    assert.equal((await index.refresh(now + 500, new Set())).find(f => f.id === 'fresh')?.prompts.length, 1);
    const half = turn('task_complete', now, 'u1');
    await appendFile(fresh, half.slice(0, 20));
    await appendFile(old, turn('task_started', now, 'r1') + '\n');
    let next = await index.refresh(now + 1000, new Set());
    assert.equal(next.find(f => f.id === 'fresh')?.turns.length, 1, 'partial line waits');
    assert.equal(next.find(f => f.id === 'old')?.turns[0].id, 'r1');
    await appendFile(fresh, half.slice(20) + '\n');
    next = await index.refresh(now + 2000, new Set());
    assert.deepEqual(next.find(f => f.id === 'fresh')?.turns.map(t => t.kind), ['started', 'complete']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a dormant resumed file keeps the first turn written after resume', async () => {
  // Real 2026-11-19 case: `codex resume` wrote thread_settings_applied and the user's
  // task_started 8 ms apart into a file idle for minutes; reading from the size at
  // first sight dropped that task_started, so submit evidence never bound the PTY.
  const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'rollout-'));
  try {
    const now = Date.now();
    const date = new Date(now);
    const day = path.join(dir, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'));
    await mkdir(day, { recursive: true });
    const resumed = path.join(day, 'rollout-resumed.jsonl');
    await writeFile(resumed, [meta('resumed', now - 3_600_000), turn('task_started', now - 600_000, 'h1'),
      turn('task_complete', now - 590_000, 'h1')].join('\n') + '\n');
    const idle = new Date(now - 300_000);
    await utimes(resumed, idle, idle);
    const index = new RolloutIndex(dir);
    assert.deepEqual((await index.refresh(now, new Set())).map(f => f.id), [], 'idle files are not candidates');
    await appendFile(resumed, [JSON.stringify({ timestamp: new Date(now + 500).toISOString(), type: 'event_msg',
      payload: { type: 'thread_settings_applied' } }), turn('task_started', now + 508, 'u1')].join('\n') + '\n');
    const next = (await index.refresh(now + 1000, new Set())).find(f => f.id === 'resumed');
    assert.deepEqual(next?.turns.map(t => [t.kind, t.id]), [['started', 'u1']], 'old history stays skipped, the new turn is kept');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
