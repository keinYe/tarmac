import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, appendFile, rename, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from './history.ts';
import type { HookEnvelope, Provider } from '../../protocol/src/index.ts';

// Synthetic events only; no user configuration or real agent transcript is read.
function event(name: string, payload: Record<string, unknown> = {}, provider: Provider = 'codex'): HookEnvelope {
  return {
    eventId: randomUUID(), sessionId: 'pty', instanceId: 'instance', provider,
    payload: { session_id: 'agent-session', hook_event_name: name, ...payload },
  };
}
async function fixture(t: test.TestContext): Promise<{ dir: string; store: HistoryStore }> {
  const base = resolve('.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new HistoryStore(dir);
  await store.initialize();
  return { dir, store };
}

test('durable journal deduplicates all events, not identical independent input', async t => {
  const { dir, store } = await fixture(t);
  const start = event('SessionStart');
  const first = event('UserPromptSubmit', { prompt: 'same' });
  assert.deepEqual(await store.accept(start), { duplicate: false });
  assert.deepEqual(await store.accept(start), { duplicate: true });
  await store.accept(first);
  assert.deepEqual(await store.accept(first), { duplicate: true });
  await store.accept(event('UserPromptSubmit', { prompt: 'same' }));
  assert.equal(store.hasEvent(start.eventId), true);
  const view = store.view('codex', 'agent-session');
  assert.deepEqual(view.records.map(record => record.prompt), ['same', 'same']);
  assert.deepEqual(view.records.map(record => record.seq), [2, 3]);
  assert.equal(view.unread, 2);
  const journal = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(journal.length, 3);
  const restored = new HistoryStore(dir);
  await restored.initialize();
  assert.deepEqual(restored.view('codex', 'agent-session'), view);
  assert.deepEqual(await restored.accept(first), { duplicate: true });
});

test('prompts read from an agent log use their stable id, keep their time and survive restart once', async t => {
  const { dir, store } = await fixture(t);
  const input = { eventId: 'codex-rollout:m1', provider: 'codex' as const, agentSessionId: 'thread', at: '2026-11-20T00:00:00.000Z',
    prompt: '看下进度', tarmacSessionId: 'pty' };
  assert.deepEqual(await store.acceptPrompt(input), { duplicate: false });
  assert.deepEqual(await store.acceptPrompt(input), { duplicate: true });
  await assert.rejects(store.acceptPrompt({ ...input, eventId: 'codex-rollout:m2', at: 'not a time' }));
  const view = store.view('codex', 'thread', 'pty');
  assert.deepEqual(view.records.map(r => [r.prompt, r.at, r.tarmacSessionId]), [['看下进度', input.at, 'pty']]);
  assert.equal(store.view('codex', 'thread', 'other-pty').records.length, 0);
  const restored = new HistoryStore(dir);
  await restored.initialize();
  assert.deepEqual(restored.view('codex', 'thread', 'pty'), view);
  assert.deepEqual(await restored.acceptPrompt(input), { duplicate: true });
});

test('resume joins a provider session while another agent remains separate', async t => {
  const { store } = await fixture(t);
  await store.accept(event('UserPromptSubmit', { prompt: 'first' }));
  await store.accept(event('SessionStart', { source: 'resume' }));
  await store.accept(event('UserPromptSubmit', { prompt: 'resumed' }));
  await store.accept(event('UserPromptSubmit', { prompt: 'other', session_id: 'other' }));
  await store.accept(event('UserPromptSubmit', { prompt: 'claude' }, 'claude'));
  assert.deepEqual(store.view('codex', 'agent-session').records.map(r => r.prompt), ['first', 'resumed']);
  assert.deepEqual(store.view('codex', 'other').records.map(r => r.prompt), ['other']);
  assert.deepEqual(store.view('claude', 'agent-session').records.map(r => r.prompt), ['claude']);
  assert.equal(store.view('codex', 'missing').unread, 0);
});

test('reading position survives restart, never goes backward, and clamps to known input', async t => {
  const { dir, store } = await fixture(t);
  await store.accept(event('UserPromptSubmit', { prompt: 'one' }));
  await store.accept(event('UserPromptSubmit', { prompt: 'two' }));
  await store.markRead('codex', 'agent-session', 1);
  assert.equal(store.view('codex', 'agent-session').unread, 1);
  await store.markRead('codex', 'agent-session', 0);
  assert.equal(store.view('codex', 'agent-session').readSeq, 1);
  const restored = new HistoryStore(dir);
  await restored.initialize();
  assert.equal(restored.view('codex', 'agent-session').unread, 1);
  await restored.markRead('codex', 'agent-session', 999999);
  assert.equal(restored.view('codex', 'agent-session').readSeq, 2);
  await restored.accept(event('UserPromptSubmit', { prompt: 'after reopen' }));
  assert.equal(restored.view('codex', 'agent-session').unread, 1);
  await assert.rejects(restored.markRead('codex', 'agent-session', -1), /invalid/);
});

test('multi-line and oversized scanner-length input survives; tool payloads are not logged', async t => {
  const { dir, store } = await fixture(t);
  const prompt = '中文\n'.repeat(150000);
  await store.accept(event('UserPromptSubmit', { prompt }));
  await store.accept(event('PostToolUse', { tool_input: { token: 'TEST_ONLY_SECRET' }, tool_response: { token: 'TEST_ONLY_SECRET' } }));
  const restored = new HistoryStore(dir);
  await restored.initialize();
  assert.equal(restored.view('codex', 'agent-session').records[0].prompt, prompt);
  assert.equal((await readFile(join(dir, 'events.jsonl'), 'utf8')).includes('TEST_ONLY_SECRET'), false);
});

test('a partial unacknowledged tail is repaired visibly before subsequent appends', async t => {
  const { dir, store } = await fixture(t);
  const one = event('UserPromptSubmit', { prompt: 'durable' });
  await store.accept(one);
  await appendFile(join(dir, 'events.jsonl'), '{"v":1,"eventId":"unconfirmed');
  const restored = new HistoryStore(dir);
  await restored.initialize();
  assert.match(restored.lastError!, /末尾不完整/);
  assert.equal(restored.view('codex', 'agent-session').records.length, 1);
  assert.deepEqual(await restored.accept(one), { duplicate: true });
  await restored.accept(event('UserPromptSubmit', { prompt: 'after repair' }));
  const next = new HistoryStore(dir);
  await next.initialize();
  assert.equal(next.view('codex', 'agent-session').records.length, 2);
});

test('complete malformed journal entries refuse startup without silently discarding data', async t => {
  const { dir, store } = await fixture(t);
  await store.accept(event('UserPromptSubmit', { prompt: 'before corruption' }));
  await appendFile(join(dir, 'events.jsonl'), 'corrupted\n');
  const before = await readFile(join(dir, 'events.jsonl'));
  const restored = new HistoryStore(dir);
  await assert.rejects(restored.initialize());
  assert.deepEqual(await readFile(join(dir, 'events.jsonl')), before);
  assert.match(restored.lastError!, /初始化失败/);
  await assert.rejects(restored.accept(event('SessionStart')), /初始化失败/);
});

test('concurrent retries append once and input record sequences stay unique', async t => {
  const { store } = await fixture(t);
  const shared = event('UserPromptSubmit', { prompt: 'once' });
  const result = await Promise.all([store.accept(shared), store.accept(shared), store.accept(shared)]);
  assert.equal(result.filter(r => !r.duplicate).length, 1);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.accept(event('UserPromptSubmit', { prompt: String(i) }))));
  const records = store.view('codex', 'agent-session').records;
  assert.equal(records.length, 13);
  assert.equal(new Set(records.map(r => r.seq)).size, 13);
});

test('write failure never confirms or mutates records and blocks retry until reinitialized', async t => {
  const { dir, store } = await fixture(t);
  const path = join(dir, 'events.jsonl');
  const saved = join(dir, 'events.saved');
  await rename(path, saved);
  await mkdir(path);
  const input = event('UserPromptSubmit', { prompt: 'not acknowledged' });
  await assert.rejects(store.accept(input));
  assert.equal(store.hasEvent(input.eventId), false);
  assert.equal(store.view('codex', 'agent-session').records.length, 0);
  assert.match(store.view('codex', 'agent-session').error!, /投递未确认/);
  await rm(path, { recursive: true });
  await rename(saved, path);
  await assert.rejects(store.accept(input), /投递未确认/);
  await store.initialize();
  assert.deepEqual(await store.accept(input), { duplicate: false });
});

test('reading position failure does not mark inputs read in memory', async t => {
  const { dir, store } = await fixture(t);
  await store.accept(event('UserPromptSubmit', { prompt: 'unread' }));
  await mkdir(join(dir, 'read.json'));
  await assert.rejects(store.markRead('codex', 'agent-session', 1));
  assert.equal(store.view('codex', 'agent-session').unread, 1);
  assert.match(store.lastError!, /阅读位置保存失败/);
});

test('failed fsync is not acknowledged; reinitialize syncs a complete tail before deduplicating', async t => {
  const { dir, store } = await fixture(t);
  const handle = await open(join(dir, 'events.jsonl'), 'r');
  const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
  const original = prototype.sync;
  await handle.close();
  const input = event('UserPromptSubmit', { prompt: 'written but not confirmed' });
  prototype.sync = async () => { throw new Error('synthetic fsync failure'); };
  try {
    await assert.rejects(store.accept(input), /synthetic fsync failure/);
    assert.equal(store.hasEvent(input.eventId), false);
    assert.equal(store.view('codex', 'agent-session').records.length, 0);
    await assert.rejects(store.accept(input), /投递未确认/);
  } finally { prototype.sync = original; }
  await store.initialize();
  assert.equal(store.hasEvent(input.eventId), true);
  assert.equal(store.view('codex', 'agent-session').records.length, 1);
  assert.deepEqual(await store.accept(input), { duplicate: true });
});

test('invalid input is rejected and subagent prompts are journaled but not shown as user input', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.accept(event('UserPromptSubmit')), /requires prompt/);
  await assert.rejects(store.accept(event('Stop', { session_id: '' })), /requires session_id/);
  await assert.rejects(store.accept(event('UserPromptSubmit', { prompt: 'x'.repeat(4 * 1024 * 1024) })), /exceeds limit/);
  await store.accept(event('UserPromptSubmit', { prompt: 'internal child prompt', agent_id: 'child' }));
  assert.equal(store.view('codex', 'agent-session').records.length, 0);
  await store.accept(event('UserPromptSubmit', { prompt: '' }));
  assert.equal(store.view('codex', 'agent-session').records[0].prompt, '');
});

test('invalid read-position JSON is visible rather than silently resetting unread', async t => {
  const { dir } = await fixture(t);
  await writeFile(join(dir, 'read.json'), '{"v":1,"read":[{"provider":"codex","sessionId":"s","seq":-1}]}');
  const store = new HistoryStore(dir);
  await assert.rejects(store.initialize(), /invalid reading position/);
});

test('PTY-scoped history and read positions remain separate after restart, while legacy records stay available', async t => {
  const { dir, store } = await fixture(t);
  await store.accept({ ...event('UserPromptSubmit', { prompt: 'A' }), sessionId: 'pty-a' });
  await store.accept({ ...event('UserPromptSubmit', { prompt: 'B' }), sessionId: 'pty-b' });
  assert.deepEqual(store.view('codex', 'agent-session', 'pty-a').records.map(r => r.prompt), ['A']);
  assert.deepEqual(store.view('codex', 'agent-session', 'pty-b').records.map(r => r.prompt), ['B']);
  await store.markRead('codex', 'agent-session', 9999, 'pty-a');
  const restored = new HistoryStore(dir);
  await restored.initialize();
  assert.equal(restored.view('codex', 'agent-session', 'pty-a').unread, 0);
  assert.equal(restored.view('codex', 'agent-session', 'pty-b').unread, 1);
  assert.deepEqual(restored.view('codex', 'agent-session').records.map(r => r.prompt), ['A', 'B']);
  assert.equal(restored.view('codex', 'agent-session', 'new-pty').records.length, 0);
});

test('Antigravity PreInvocation prompt is journaled and visible in history view', async t => {
  const { dir, store } = await fixture(t);
  const agyEvent: HookEnvelope = {
    eventId: randomUUID(),
    sessionId: 'pty-1',
    instanceId: 'inst-1',
    provider: 'agy',
    payload: {
      session_id: 'agy-conv-1',
      hook_event_name: 'PreInvocation',
      prompt: 'fix test for agy',
      invocationNum: 0,
    },
  };
  assert.deepEqual(await store.accept(agyEvent), { duplicate: false });
  // Later model calls of the same turn repeat lastUserInput and must not be journaled again.
  const followUp = { ...agyEvent, eventId: randomUUID(), payload: { ...agyEvent.payload, invocationNum: 1 } };
  assert.deepEqual(await store.accept(followUp), { duplicate: false });
  const view = store.view('agy', 'agy-conv-1', 'pty-1');
  assert.equal(view.records.length, 1);
  assert.equal(view.records[0].prompt, 'fix test for agy');
  assert.equal(view.records[0].provider, 'agy');
});
