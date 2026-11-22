import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageReader, HookUsage } from './usage.ts';
import type { Provider, HookEnvelope } from '../../protocol/src/index.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const claude = (id: string, input = 100, output = 10, extra = {}) => ({
  type: 'assistant', sessionId: 's', message: { id, usage: {
    input_tokens: input, output_tokens: output, cache_read_input_tokens: 40, cache_creation_input_tokens: 20,
  } }, ...extra,
});
const codex = (input = 1000, output = 100) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output,
    cached_input_tokens: 800, reasoning_output_tokens: 50 },
} } });
async function fixture(provider: Provider, data: string, sessionId: string | undefined = 's') {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'usage-'));
  const file = provider === 'kimi' ? path.join(dir, sessionId ?? 's', 'agents/main/wire.jsonl')
    : provider === 'agy' ? path.join(dir, sessionId ?? 's', '.system_generated/logs/transcript_full.jsonl')
    : path.join(dir, 'session.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return { dir, file, reader: new UsageReader(provider, '42', file, sessionId),
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('overlapping reads of one reader share a single pass instead of interleaving chunks', async () => {
  // Status-line and hook events bypass the poll interval, so a read can start while another is
  // still catching up; interleaved chunks used to corrupt lines into a sticky JSON error.
  const rows = Array.from({ length: 2000 }, (_, index) => claude(`m${index}`, 100, 10, { padding: 'x'.repeat(800) }));
  const t = await fixture('claude', jsonl(...rows));
  try {
    const [first, second] = await Promise.all([t.reader.read(), t.reader.read()]);
    assert.equal(first?.totalTokens, 2000 * 170);
    assert.equal(second?.totalTokens, 2000 * 170);
  } finally { await t.cleanup(); }
});

test('Claude sums unique responses, replaces streamed usage and excludes sidechain records', async () => {
  const data = jsonl(claude('a'), claude('a', 100, 15), claude('a', 100, 15),
    claude('b', 200, 5), claude('sub', 999, 999, { isSidechain: true, sessionId: 'sub-session' }));
  const t = await fixture('claude', data);
  try {
    assert.deepEqual(await t.reader.read(), { provider: 'claude', agentRunId: '42', agentSessionId: 's',
      inputTokens: 420, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 40, totalTokens: 440 });
    assert.equal((await t.reader.read())?.totalTokens, 440, 'unchanged reads do not add again');
    assert.equal(await readFile(t.file, 'utf8'), data, 'collection does not modify the transcript');
  } finally { await t.cleanup(); }
});

test('Codex uses the latest cumulative snapshot without adding cache or reasoning twice', async () => {
  const t = await fixture('codex', jsonl({ type: 'session_meta', payload: { id: 's' } }, codex(), codex()));
  try {
    assert.equal((await t.reader.read())?.totalTokens, 1100);
    await appendFile(t.file, jsonl(codex(1500, 200), { type: 'event_msg', payload: { type: 'token_count', info: null } }));
    assert.deepEqual(await t.reader.read(), { provider: 'codex', agentRunId: '42', agentSessionId: 's',
      inputTokens: 1500, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, totalTokens: 1700 });
  } finally { await t.cleanup(); }
});

test('split UTF-8 and incomplete JSON lines wait for complete records', async () => {
  const line = Buffer.from(jsonl({ ...claude('a'), note: '你好' }));
  const cut = line.indexOf(Buffer.from('你好')) + 1;
  const t = await fixture('claude', '');
  try {
    await appendFile(t.file, line.subarray(0, cut));
    assert.equal(await t.reader.read(), undefined);
    await appendFile(t.file, line.subarray(cut));
    assert.equal((await t.reader.read())?.totalTokens, 170);
  } finally { await t.cleanup(); }
});

test('Codex quota-only events retain tokens, use window metadata and ignore separate pools', async () => {
  const quota = (at: string, limitId = 'codex', extra = {}) => ({ timestamp: at, type: 'event_msg', payload: {
    type: 'token_count', info: null, rate_limits: { limit_id: limitId,
      primary: { window_minutes: 10080, used_percent: 7, resets_at: 2000000000 },
      secondary: { window_minutes: 300, used_percent: 37, resets_at: 1900000000 }, ...extra },
  } });
  const t = await fixture('codex', jsonl({ type: 'session_meta', payload: { id: 's' } }, codex(), quota('2026-11-15T01:00:00Z')));
  try {
    const usage = await t.reader.read();
    assert.equal(usage?.totalTokens, 1100);
    assert.deepEqual(usage?.rateLimits, { observedAt: '2026-11-15T01:00:00.000Z', windows: [
      { windowMinutes: 10080, usedPercent: 7, resetsAt: 2000000000 },
      { windowMinutes: 300, usedPercent: 37, resetsAt: 1900000000 },
    ] });
    await appendFile(t.file, jsonl(quota('2026-11-15T02:00:00Z', 'codex_spark'), quota('2026-11-14T01:00:00Z')));
    assert.deepEqual((await t.reader.read())?.rateLimits, usage?.rateLimits);
    await appendFile(t.file, jsonl(quota('2026-11-15T03:00:00Z', 'codex', {
      primary: { window_minutes: 300, used_percent: -1, resets_at: 1900000000 }, secondary: null,
    })));
    assert.equal((await t.reader.read())?.rateLimits, undefined);
    assert.equal((await t.reader.read())?.totalTokens, 1100, 'invalid quota does not discard valid token counts');
    await writeFile(t.file, jsonl({ type: 'session_meta', payload: { id: 's' } }, codex(1500)));
    assert.equal((await t.reader.read())?.rateLimits, undefined, 'truncation clears earlier account data');
  } finally { await t.cleanup(); }
});

test('rotation and truncation discard earlier totals', async () => {
  const t = await fixture('claude', jsonl(claude('a'), claude('b')));
  try {
    assert.equal((await t.reader.read())?.totalTokens, 340);
    await writeFile(t.file, jsonl(claude('c', 1, 2)));
    assert.equal((await t.reader.read())?.totalTokens, 63);
    const replacement = path.join(t.dir, 'replacement.jsonl');
    await writeFile(replacement, jsonl(claude('d', 2, 3)));
    await rename(replacement, t.file);
    assert.equal((await t.reader.read())?.totalTokens, 65);
  } finally { await t.cleanup(); }
});

test('process-associated Codex file needs its own session metadata', async () => {
  const t = await fixture('codex', jsonl({ type: 'session_meta', payload: { id: 's' } }, codex()));
  try {
    const discovered = new UsageReader('codex', '42', t.file);
    assert.equal((await discovered.read())?.agentSessionId, 's');
    await writeFile(t.file, jsonl(codex()));
    await assert.rejects(discovered.read(), /会话关联/);
  } finally { await t.cleanup(); }
});

test('different conversations are rejected even when a file contains valid usage', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const data = provider === 'claude' ? jsonl(claude('a', 100, 10, { sessionId: 'other' }))
      : jsonl({ type: 'session_meta', payload: { id: 'other' } }, codex());
    const t = await fixture(provider, data);
    try { await assert.rejects(t.reader.read(), /不匹配/); }
    finally { await t.cleanup(); }
  }
});

test('invalid counters, missing message identity and malformed records never become plausible totals', async () => {
  for (const data of [jsonl(claude('a', -1)), jsonl(claude('a', 1.5)), jsonl(claude('a', Number.MAX_SAFE_INTEGER)),
    jsonl(claude('', 1)), '{broken}\n']) {
    const t = await fixture('claude', data);
    try { await assert.rejects(t.reader.read()); }
    finally { await t.cleanup(); }
  }
  const t = await fixture('codex', jsonl(codex(10, 5)));
  try { await assert.rejects(t.reader.read(), /缓存/); }
  finally { await t.cleanup(); }
});

test('unknown records and empty files do not fabricate usage; zero is valid', async () => {
  const t = await fixture('claude', jsonl({ type: 'user', sessionId: 's' }));
  try {
    assert.equal(await t.reader.read(), undefined);
    await appendFile(t.file, jsonl({ type: 'assistant', sessionId: 's', message: { id: 'zero',
      usage: { input_tokens: 0, output_tokens: 0 } } }));
    assert.equal((await t.reader.read())?.totalTokens, 0);
  } finally { await t.cleanup(); }
});

test('large first loads yield without publishing a partial total', async () => {
  const padding = jsonl({ type: 'user', content: 'x'.repeat(5 * 1024 * 1024) });
  const t = await fixture('claude', padding + jsonl(claude('a')));
  try {
    assert.equal(await t.reader.read(), undefined);
    assert.equal((await t.reader.read())?.totalTokens, 170);
  } finally { await t.cleanup(); }
});

test('Kimi wire increments, partial lines, truncation and exact session paths', async () => {
  const row = { type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 100, output: 20, inputCacheRead: 300, inputCacheCreation: 40 } };
  const t = await fixture('kimi', jsonl({ type: 'llm.request' }, row));
  try {
    assert.equal((await t.reader.read())?.totalTokens, 460);
    const line = jsonl(row);
    await appendFile(t.file, line.slice(0, 20));
    assert.equal((await t.reader.read())?.totalTokens, 460);
    await appendFile(t.file, line.slice(20));
    assert.equal((await t.reader.read())?.totalTokens, 920);
    assert.equal((await t.reader.read())?.totalTokens, 920);
    await writeFile(t.file, jsonl(row));
    assert.equal((await t.reader.read())?.totalTokens, 460);
    assert.throws(() => new UsageReader('kimi', '42', t.file, 'wrong'), /不匹配/);
    await appendFile(t.file, jsonl({ ...row, usage: { output: -1 } }));
    await assert.rejects(t.reader.read(), /无效/);
  } finally { await t.cleanup(); }
});

// Shape from a real agy transcript_full.jsonl (2026-11-19): per-call counts, input excludes cache reads.
test('agy sums planner steps once, adds cache reads to input and requires the exact conversation path', async () => {
  const step = (index: number, input: number, cache: number, output: number) => ({ step_index: index, source: 'MODEL',
    type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-3.8-flash-medium',
    input_tokens: input, cache_read_tokens: cache, output_tokens: output });
  const t = await fixture('agy', jsonl({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hi' },
    step(1, 13389, 0, 589), { step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'tool' }, step(4, 2966, 11338, 351)));
  try {
    const usage = await t.reader.read();
    assert.deepEqual(usage && { ...usage }, { provider: 'agy', agentRunId: '42', agentSessionId: 's',
      inputTokens: 27693, outputTokens: 940, cacheReadTokens: 11338, cacheWriteTokens: 0, totalTokens: 28633 });
    await appendFile(t.file, jsonl(step(4, 2966, 11338, 351)));
    assert.equal((await t.reader.read())?.totalTokens, 28633);
    assert.throws(() => new UsageReader('agy', '42', t.file, 'other'), /不匹配/);
    assert.throws(() => new UsageReader('agy', '42', path.join(t.dir, 's/.system_generated/logs/transcript.jsonl'), 's'), /不匹配/);
    await appendFile(t.file, jsonl({ ...step(5, 1, 0, 1), step_index: 'x' }));
    await assert.rejects(t.reader.read(), /步骤序号/);
  } finally { await t.cleanup(); }
  const empty = await fixture('agy', jsonl({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT' }));
  try { assert.equal(await empty.reader.read(), undefined); } finally { await empty.cleanup(); }
});

test('Kimi wire turn.ended records main-agent turn ends without affecting usage', async () => {
  const row = { type: 'usage.record', usage: { inputOther: 100, output: 20 } };
  const t = await fixture('kimi', jsonl(
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', durationMs: 10, time: 1000 },
    { type: 'turn.ended', agentId: 'subagent-1', turnId: 1, reason: 'completed', time: 1100 },
    { type: 'turn.ended', agentId: 'main', turnId: '2', reason: 'completed', time: 1200 },
    { type: 'turn.ended', agentId: 'main', turnId: 3, reason: 'cancelled' },
  ));
  try {
    // A turn end alone is not usage.
    assert.equal(await t.reader.read(), undefined);
    assert.deepEqual(t.reader.kimiTurnEnd(0), { reason: 'completed', time: 1000 });
    assert.equal(t.reader.kimiTurnEnd(1), undefined);
    assert.equal(t.reader.kimiTurnEnd(2), undefined);
    assert.equal(t.reader.kimiTurnEnd(3), undefined);
    await appendFile(t.file, jsonl(row, { type: 'turn.ended', agentId: 'main', turnId: 4, reason: 'failed', time: 2000 }));
    assert.equal((await t.reader.read())?.totalTokens, 120);
    assert.deepEqual(t.reader.kimiTurnEnd(4), { reason: 'failed', time: 2000 });
    // Truncation drops ends read from the previous file contents.
    await writeFile(t.file, jsonl(row));
    await t.reader.read();
    assert.equal(t.reader.kimiTurnEnd(0), undefined);
  } finally { await t.cleanup(); }
});

test('Codex per-attempt hooks count only delivered events without double counting cache or retries', () => {
  const reader = new HookUsage();
  const event: HookEnvelope = { eventId: 'a', sessionId: 'pty', instanceId: 'instance', provider: 'codex',
    payload: { session_id: 's', hook_event_name: 'PostModelRequest', token_usage: {
      input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, reasoning_output_tokens: 10,
    } } };
  reader.apply(event, '42');
  reader.apply(event, '42');
  assert.equal(reader.view?.totalTokens, 120);
  assert.equal(reader.view?.scope, 'observed');
  reader.apply({ ...event, eventId: 'b' }, '42');
  assert.equal(reader.view?.totalTokens, 240);
  reader.apply({ ...event, eventId: 'foreign', payload: { ...event.payload, session_id: 'other' } }, '42');
  reader.apply({ ...event, eventId: 'null', payload: { ...event.payload, token_usage: null } }, '42');
  reader.apply({ ...event, eventId: 'invalid', payload: { ...event.payload, token_usage: { input_tokens: -1, output_tokens: 2 } } }, '42');
  assert.equal(reader.view?.totalTokens, 240);
  reader.reset();
  assert.equal(reader.view, undefined);
});
