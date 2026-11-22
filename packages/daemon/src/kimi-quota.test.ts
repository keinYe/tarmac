import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { KIMI_QUOTA_BASES, KIMI_QUOTA_MAX_AGE_MS, KIMI_QUOTA_REFRESH_MS, KimiQuota, kimiAccessToken, kimiQuotaBase, parseKimiQuota } from './kimi-quota.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, '.tmp/app-m0-validation');
const NOW = Date.parse('2026-11-19T12:00:00Z');

async function kimiDir(credentials?: unknown, config?: string): Promise<string> {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'kimi-quota-'));
  if (credentials !== undefined) {
    await mkdir(path.join(dir, 'credentials'));
    await writeFile(path.join(dir, 'credentials', 'kimi-code.json'), typeof credentials === 'string' ? credentials : JSON.stringify(credentials));
  }
  if (config !== undefined) await writeFile(path.join(dir, 'config.toml'), config);
  return dir;
}

// Shape served to Kimi 2.6 (fields read by its parseQuotaUsages); values are synthetic.
const PAYLOAD = { usages: {
  limit_5h: { used_ratio: 0.07, reset_time: '2026-11-19T15:00:00Z' },
  limit_7d: { used_ratio: '0.33', reset_time: '2026-11-24T00:00:00Z' },
  limit_month_total: { used_ratio: 1.4, reset_time: '2026-12-01T00:00:00Z' },
  limit_month_code: { used_ratio: 0.2, reset_time: '2026-12-01T00:00:00Z' },
}, boosterWallet: { balance: { type: 'BOOSTER', amount: 100, amountLeft: 50 } } };

test('only an unexpired access token is used; refresh tokens and expired or malformed files are not', async () => {
  const valid = await kimiDir({ access_token: 'at', refresh_token: 'rt', expires_at: NOW / 1000 + 60 });
  const expired = await kimiDir({ access_token: 'at', refresh_token: 'rt', expires_at: NOW / 1000 - 1 });
  const refreshOnly = await kimiDir({ refresh_token: 'rt', expires_at: NOW / 1000 + 60 });
  const noExpiry = await kimiDir({ access_token: 'at' });
  const malformed = await kimiDir('{not json');
  const missing = await kimiDir();
  try {
    assert.equal(await kimiAccessToken(valid, NOW), 'at');
    for (const dir of [expired, refreshOnly, noExpiry, malformed, missing]) assert.equal(await kimiAccessToken(dir, NOW), undefined);
  } finally { for (const dir of [valid, expired, refreshOnly, noExpiry, malformed, missing]) await rm(dir, { recursive: true, force: true }); }
});

test('the quota endpoint is one of the two official hosts, chosen by the managed provider base_url', async () => {
  const dirs = await Promise.all([
    kimiDir(undefined, '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1/"\n'),
    kimiDir(undefined, '[providers."managed:kimi-code"]\nbase_url = "https://evil.example/coding/v1"\n'),
    kimiDir(undefined, '[providers.other]\nbase_url = "https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code"]\ntype = "kimi"\n'),
    kimiDir(),
  ]);
  try {
    assert.deepEqual(await Promise.all(dirs.map(kimiQuotaBase)), [KIMI_QUOTA_BASES[1], KIMI_QUOTA_BASES[0], KIMI_QUOTA_BASES[0], KIMI_QUOTA_BASES[0]]);
  } finally { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); }
});

test('quota windows follow Kimi field names, clamp ratios and drop windows without a reset time', () => {
  const limits = parseKimiQuota(PAYLOAD, 'observed');
  assert.deepEqual(limits, { observedAt: 'observed', source: 'account', windows: [
    { windowMinutes: 300, usedPercent: 7, resetsAt: Date.parse('2026-11-19T15:00:00Z') / 1000 },
    { windowMinutes: 10_080, usedPercent: 33, resetsAt: Date.parse('2026-11-24T00:00:00Z') / 1000 },
    { windowMinutes: 0, period: '月', usedPercent: 100, resetsAt: Date.parse('2026-12-01T00:00:00Z') / 1000 },
  ] });
  const partial = parseKimiQuota({ usages: { limit_5h: { used_ratio: 0.5 }, limit_7d: { reset_time: '2026-11-24T00:00:00Z' },
    limit_month_total: { used_ratio: 'x', reset_time: 'later' } } }, 'observed');
  assert.equal(partial, undefined, 'no window has both a ratio and a reset time');
  for (const payload of [null, 'text', {}, { usages: [] }, { limits: [{ window: { duration: 300 } }] }]) assert.equal(parseKimiQuota(payload, 'o'), undefined);
});

test('one request per refresh interval, only with a token, only to the official host, hidden once stale', async () => {
  const dir = await kimiDir({ access_token: 'at', expires_at: NOW / 1000 + 86400 });
  let now = NOW;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let respond: () => Promise<{ ok: boolean; json(): Promise<unknown> }> = async () => ({ ok: true, json: async () => PAYLOAD });
  const quota = new KimiQuota(async (url, init) => { calls.push({ url, headers: init.headers }); return respond(); }, () => now);
  const settle = () => delay(30);
  try {
    assert.equal(quota.limits(dir), undefined);
    quota.poll(dir); quota.poll(dir);
    await settle();
    assert.equal(calls.length, 1, 'concurrent polls share one request');
    assert.deepEqual(calls[0], { url: `${KIMI_QUOTA_BASES[0]}/usages`, headers: { Authorization: 'Bearer at', Accept: 'application/json' } });
    assert.equal(quota.limits(dir)?.windows.length, 3);
    now += KIMI_QUOTA_REFRESH_MS - 1; quota.poll(dir); await settle();
    assert.equal(calls.length, 1, 'no request within the refresh interval');
    // A failed refresh keeps the last result until it is too old to show.
    respond = async () => ({ ok: false, json: async () => ({}) });
    now += 1; quota.poll(dir); await settle();
    assert.equal(calls.length, 2);
    assert.equal(quota.limits(dir)?.windows.length, 3);
    now = NOW + KIMI_QUOTA_MAX_AGE_MS + 1;
    assert.equal(quota.limits(dir), undefined, 'a result older than 15 minutes is not shown');
    respond = async () => { throw new Error('offline'); };
    quota.poll(dir); await settle();
    assert.equal(quota.limits(dir), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const expired = await kimiDir({ access_token: 'at', expires_at: NOW / 1000 - 1 });
  try {
    const before = calls.length;
    quota.poll(expired); await settle();
    assert.equal(calls.length, before, 'an expired token sends nothing');
  } finally { await rm(expired, { recursive: true, force: true }); }
});
