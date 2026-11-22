import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TokenUsage } from '../../protocol/src/index.ts';

// Kimi plan quota from its account endpoint, the one credential exception the App makes (owner
// approved 2026-11-19; boundaries in docs/app-hooks-usage.md, "凭据"). The token is Kimi's own
// unexpired access_token, used for this one request and never refreshed, stored or logged.

type RateLimits = NonNullable<TokenUsage['rateLimits']>;
type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export const KIMI_QUOTA_BASES = ['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'] as const;
export const KIMI_QUOTA_REFRESH_MS = 120_000;
export const KIMI_QUOTA_MAX_AGE_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 8000;

// The access token, only while it is unexpired. Kimi refreshes and rewrites it itself; refreshing
// here could race Kimi's own rotation, so an expired or missing token means no request.
export async function kimiAccessToken(home: string, now: number = Date.now()): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(path.join(home, 'credentials', 'kimi-code.json'), 'utf8'));
    if (!saved || typeof saved !== 'object') return;
    const { access_token: token, expires_at: expires } = saved as Record<string, unknown>;
    return typeof token === 'string' && token && typeof expires === 'number' && expires * 1000 > now ? token : undefined;
  } catch { return; }
}

// The managed provider's base_url picks between the two official hosts; any other value falls
// back to the first, so the token is never sent anywhere else.
export async function kimiQuotaBase(home: string): Promise<string> {
  let text = '';
  try { text = await readFile(path.join(home, 'config.toml'), 'utf8'); } catch { return KIMI_QUOTA_BASES[0]; }
  let inProvider = false;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (table) { inProvider = table[1].replace(/\s+/g, '') === 'providers."managed:kimi-code"'; continue; }
    const value = inProvider ? /^\s*base_url\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line) : null;
    if (value) return KIMI_QUOTA_BASES.find(base => base === value[1].trim().replace(/\/+$/, '')) ?? KIMI_QUOTA_BASES[0];
  }
  return KIMI_QUOTA_BASES[0];
}

// Fields as Kimi 2.6 parses them (parseQuotaUsages). A window lacking a ratio or reset time is
// left out rather than estimated.
export function parseKimiQuota(payload: unknown, observedAt: string): RateLimits | undefined {
  const usages = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).usages : undefined;
  if (!usages || typeof usages !== 'object') return;
  const windows: RateLimits['windows'] = [];
  for (const [key, windowMinutes, period] of [['limit_5h', 300, undefined], ['limit_7d', 10_080, undefined], ['limit_month_total', 0, '月']] as const) {
    const entry = (usages as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;
    const { used_ratio: raw, reset_time: reset } = entry as Record<string, unknown>;
    const ratio = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    const resetsAt = typeof reset === 'string' ? Math.floor(Date.parse(reset) / 1000) : NaN;
    if (!Number.isFinite(ratio) || !Number.isSafeInteger(resetsAt) || resetsAt <= 0) continue;
    windows.push({ windowMinutes, ...(period ? { period } : {}), usedPercent: Math.round(Math.min(1, Math.max(0, ratio)) * 100), resetsAt });
  }
  return windows.length ? { observedAt, source: 'account', windows } : undefined;
}

// One cache per Kimi data directory, shared by its sessions: at most one request per refresh
// interval, and a result older than the display limit is no longer shown.
export class KimiQuota {
  private entries = new Map<string, { limits?: RateLimits; fetchedAt: number; attemptAt: number; inFlight: boolean }>();
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  constructor(fetchImpl: Fetch = fetch as unknown as Fetch, now: () => number = Date.now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  limits(home: string): RateLimits | undefined {
    const entry = this.entries.get(home);
    return entry?.limits && this.now() - entry.fetchedAt <= KIMI_QUOTA_MAX_AGE_MS ? entry.limits : undefined;
  }

  // Starts a background refresh when due; callers read the result on a later poll.
  poll(home: string): void {
    const entry = this.entries.get(home) ?? { fetchedAt: 0, attemptAt: 0, inFlight: false };
    this.entries.set(home, entry);
    const now = this.now();
    if (entry.inFlight || now - entry.attemptAt < KIMI_QUOTA_REFRESH_MS) return;
    entry.attemptAt = now;
    entry.inFlight = true;
    void this.fetchQuota(home).then(limits => {
      if (limits) { entry.limits = limits; entry.fetchedAt = this.now(); }
    }).catch(() => {}).finally(() => { entry.inFlight = false; });
  }

  private async fetchQuota(home: string): Promise<RateLimits | undefined> {
    const token = await kimiAccessToken(home, this.now());
    if (!token) return;
    const url = `${await kimiQuotaBase(home)}/usages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) return;
      return parseKimiQuota(await response.json(), new Date(this.now()).toISOString());
    } finally { clearTimeout(timer); }
  }
}
