import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Foreground, TokenUsage } from '../../protocol/src/index.ts';

const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Env = Record<string, string | undefined>;

async function jsonFile(file: string): Promise<any> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > 1024 * 1024) return;
    const buffer = Buffer.alloc(Math.min(entry.size + 1, 1024 * 1024 + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

// Claude does not retain an open transcript fd. Its read-only CLI supplies the
// live PID -> session ID mapping, including /clear and /resume transitions.
export async function claudeTranscript(current: Foreground, env: Env, home: string): Promise<{ file: string; sessionId: string } | undefined> {
  try {
    const { stdout } = await run('claude', ['agents', '--json'], {
      cwd: current.cwd, env, timeout: 2000, maxBuffer: 1024 * 1024,
    });
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows)) return;
    const matches = rows.filter(row => row?.pid === current.pid && typeof row.sessionId === 'string'
      && uuid.test(row.sessionId) && typeof row.cwd === 'string' && path.isAbsolute(row.cwd));
    if (matches.length !== 1) return;
    const { sessionId, cwd } = matches[0];
    const root = path.resolve(current.cwd, env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
    const expected = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    if ((await stat(expected).catch(() => undefined))?.isFile()) return { file: expected, sessionId };
    // Long/non-ASCII project directories can use a different bucket name. The
    // exact live UUID is authoritative; never select by cwd or modification time.
    const dirs = await readdir(root, { withFileTypes: true });
    if (dirs.length > 1000) return;
    const files = (await Promise.all(dirs.filter(dir => dir.isDirectory()).map(async dir => {
      const file = path.join(root, dir.name, `${sessionId}.jsonl`);
      return (await stat(file).catch(() => undefined))?.isFile() ? file : undefined;
    }))).filter((file): file is string => Boolean(file));
    return files.length === 1 ? { file: files[0], sessionId } : undefined;
  } catch { return; }
}

// Reuse the user's existing token-tracker cache. No statusLine/hook is installed
// or changed. A shared cache belongs to this process only after exact ID/path
// matching; another terminal's latest snapshot is never used as a fallback.
export async function claudeRateLimits(sessionId: string, transcript: string, env: Env, home: string): Promise<TokenUsage['rateLimits']> {
  try {
    const directory = env.XDG_CONFIG_HOME || path.join(home, '.config');
    const data = await jsonFile(path.join(directory, 'token-tracker/tt-status.json'));
    return claudeSnapshotLimits(data, sessionId, transcript);
  } catch { return; }
}

export function claudeSnapshotLimits(data: any, sessionId: string, transcript: string,
  observedAt?: string): TokenUsage['rateLimits'] {
  if (!data || data.session_id !== sessionId || typeof data.transcript_path !== 'string'
    || !path.isAbsolute(data.transcript_path) || path.resolve(data.transcript_path) !== path.resolve(transcript)) return;
  const at = Date.parse(observedAt ?? data._received_at);
  if (!Number.isFinite(at)) return;
  const windows = (['five_hour', 'seven_day'] as const).flatMap((key, index) => {
    const bucket = data.rate_limits?.[key];
    if (!bucket || typeof bucket.used_percentage !== 'number' || !Number.isFinite(bucket.used_percentage)
      || bucket.used_percentage < 0 || bucket.used_percentage > 100
      || !Number.isSafeInteger(bucket.resets_at) || bucket.resets_at <= 0
      || !Number.isFinite(new Date(bucket.resets_at * 1000).getTime())) return [];
    return [{ windowMinutes: index === 0 ? 300 : 10080, usedPercent: bucket.used_percentage, resetsAt: bucket.resets_at }];
  });
  return windows.length ? { observedAt: new Date(at).toISOString(), windows } : undefined;
}

// The configuration directory (one account) a main transcript belongs to:
// <config>/projects/<project>/<session>.jsonl. Taken from the exact file, not the launch
// environment, so a CLAUDE_CONFIG_DIR changed inside the shell cannot mix accounts.
export function claudeAccountOf(transcript: string): string | undefined {
  const projects = path.dirname(path.dirname(path.resolve(transcript)));
  if (path.basename(projects) !== 'projects' || !uuid.test(path.basename(transcript, '.jsonl'))) return;
  return path.dirname(projects);
}

type RateLimits = NonNullable<TokenUsage['rateLimits']>;

// Plan quota belongs to the account, not the conversation: the newest snapshot any session of
// one configuration directory adopted is offered to the others (docs/app-m0-spec.md).
export class ClaudeAccountQuota {
  private latest = new Map<string, RateLimits>();
  offer(account: string, limits: RateLimits): void {
    const current = this.latest.get(account);
    if (!current || Date.parse(limits.observedAt) > Date.parse(current.observedAt)) {
      this.latest.set(account, { observedAt: limits.observedAt, windows: limits.windows });
    }
  }
  get(account: string): RateLimits | undefined { return this.latest.get(account); }
}
