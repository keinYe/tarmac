import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeTranscript, claudeRateLimits, claudeAccountOf, ClaudeAccountQuota } from './claude-usage.ts';
import { usageFailureReason } from './session.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
async function fixture() {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'cc-'));
  const config = path.join(dir, '.claude');
  const project = path.join(config, 'projects/encoded-project');
  const cache = path.join(dir, '.config/token-tracker/tt-status.json');
  const state = path.join(dir, 'agents.json');
  const bin = path.join(dir, 'bin');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(path.dirname(cache), { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(state)}, 'utf8'));`, { mode: 0o700 });
  const env = { PATH: bin + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(dir, '.config') };
  return { dir, project, cache, state, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('Claude discovers the exact live PID and follows clear/resume without an open transcript', async () => {
  const t = await fixture();
  const current = { pid: 42, name: 'claude', provider: 'claude' as const, cwd: t.dir };
  const row = (sessionId: string, pid = 42) => ({ pid, sessionId, cwd: t.dir, kind: 'interactive' });
  try {
    const a = path.join(t.project, `${first}.jsonl`);
    const b = path.join(t.project, `${second}.jsonl`);
    await writeFile(a, ''); await writeFile(b, '');
    await writeFile(t.state, JSON.stringify([row(first), row(second, 99)]));
    assert.deepEqual(await claudeTranscript(current, t.env, t.dir), { file: a, sessionId: first });
    await writeFile(t.state, JSON.stringify([row(second)]));
    assert.deepEqual(await claudeTranscript(current, t.env, t.dir), { file: b, sessionId: second });
    for (const rows of [[], [row(first, 99)], [row(first), row(second)], [row('../outside')]]) {
      await writeFile(t.state, JSON.stringify(rows));
      assert.equal(await claudeTranscript(current, t.env, t.dir), undefined);
    }
    await writeFile(t.state, '{broken}');
    assert.equal(await claudeTranscript(current, t.env, t.dir), undefined);
  } finally { await t.cleanup(); }
});

test('Claude quota cache requires exact session and transcript; zero percent remains visible', async () => {
  const t = await fixture();
  const file = path.join(t.project, `${first}.jsonl`);
  const data = { session_id: first, transcript_path: file, _received_at: '2026-11-15T07:21:00Z', rate_limits: {
    five_hour: { used_percentage: 0, resets_at: 2000000000 }, seven_day: { used_percentage: 15, resets_at: 2000500000 },
  } };
  try {
    await writeFile(t.cache, JSON.stringify(data));
    const limits = await claudeRateLimits(first, file, t.env, t.dir);
    assert.equal(limits?.windows[0].usedPercent, 0);
    assert.equal(limits?.windows[1].windowMinutes, 10080);
    assert.equal(await claudeRateLimits(second, file, t.env, t.dir), undefined);
    assert.equal(await claudeRateLimits(first, file + '.other', t.env, t.dir), undefined);
    await writeFile(t.cache, JSON.stringify({ ...data, _received_at: 'invalid' }));
    assert.equal(await claudeRateLimits(first, file, t.env, t.dir), undefined);
    await writeFile(t.cache, JSON.stringify({ ...data, rate_limits: { five_hour: { used_percentage: -1, resets_at: 2000000000 } } }));
    assert.equal(await claudeRateLimits(first, file, t.env, t.dir), undefined);
    await writeFile(t.cache, '{broken}');
    assert.equal(await claudeRateLimits(first, file, t.env, t.dir), undefined);
  } finally { await t.cleanup(); }
});

test('the account of a transcript is its configuration directory, only for the main transcript layout', () => {
  assert.equal(claudeAccountOf(`/home/me/.claude/projects/-proj/${first}.jsonl`), '/home/me/.claude');
  assert.equal(claudeAccountOf(`/alt/config/projects/-proj/${second}.jsonl`), '/alt/config');
  assert.equal(claudeAccountOf(`/home/me/.claude/projects/-proj/${first}/subagents/agent-1.jsonl`), undefined);
  assert.equal(claudeAccountOf(`/tmp/${first}.jsonl`), undefined);
  assert.equal(claudeAccountOf('/home/me/.claude/projects/-proj/not-a-session.jsonl'), undefined);
});

test('account quota keeps the newest snapshot per configuration directory and drops its source', () => {
  const quota = new ClaudeAccountQuota();
  const at = (iso: string, percent: number) => ({ observedAt: iso, windows: [{ windowMinutes: 300, usedPercent: percent, resetsAt: 2000000000 }] });
  quota.offer('/a', at('2026-11-20T00:00:10.000Z', 40));
  quota.offer('/a', at('2026-11-20T00:00:05.000Z', 10));
  quota.offer('/b', { ...at('2026-11-20T00:00:01.000Z', 90), source: 'shared' });
  assert.equal(quota.get('/a')?.windows[0].usedPercent, 40, 'an older snapshot never replaces a newer one');
  assert.deepEqual(quota.get('/b'), at('2026-11-20T00:00:01.000Z', 90));
  assert.equal(quota.get('/c'), undefined);
});

test('usage failure reasons carry an error class, never the transcript line or path', () => {
  assert.equal(usageFailureReason(Object.assign(new Error("ENOENT: no such file or directory, open '/home/me/secret.jsonl'"), { code: 'ENOENT' })), 'ENOENT');
  let parse: unknown;
  try { JSON.parse('{"prompt":"私密内容'); } catch (error) { parse = error; }
  assert.equal(usageFailureReason(parse), '会话记录有一行不是合法 JSON');
  assert.equal(usageFailureReason(new Error('token 记录与当前会话不匹配')), 'token 记录与当前会话不匹配');
  assert.equal(usageFailureReason('oops'), '未知错误');
});
