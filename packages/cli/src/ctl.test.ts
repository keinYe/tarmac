import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Daemon } from '../../daemon/src/server.ts';
import { VERSION } from '../../protocol/src/index.ts';

// The real CLI process against an in-process daemon and the deterministic fixture agent; no user
// data directory, configuration or external service is touched.
const repo = path.resolve(import.meta.dirname, '../../..');
const base = path.join(repo, '.tmp/app-m0-validation');
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const fixture = path.join(repo, 'packages/daemon/test/fake-agent.mjs');

interface Run { code: number | null; stdout: string; stderr: string; json: Record<string, any> }
async function ctl(args: string[], stdin = '', env: Record<string, string> = {}): Promise<Run> {
  const child = spawn(process.execPath, [main, 'ctl', ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(stdin);
  const [code] = await once(child, 'close') as [number | null];
  assert.match(stdout, /^[^\n]+\n$/, `exactly one JSON line on stdout: ${JSON.stringify(stdout)}`);
  return { code, stdout, stderr, json: JSON.parse(stdout) };
}
async function directory(): Promise<string> { await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'ctl-')); }
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 100; tries++) { const value = await read(); if (value !== undefined) return value; await delay(50); }
  throw new Error('condition not reached');
}

test('ctl drives a real daemon end to end and ignores inherited TARMAC_* variables', async () => {
  const dir = await directory();
  const daemon = new Daemon(dir);
  await daemon.start();
  // A clawbot started inside another Tarmac terminal inherits these; they must not redirect ctl.
  const env = { TARMAC_SOCKET: path.join(base, 'elsewhere.sock'), TARMAC_SESSION_ID: 'x', TARMAC_INSTANCE_ID: 'y', TARMAC_DATA_DIR: path.join(base, 'elsewhere') };
  const data = ['--data-dir', dir];
  const secret = 'SECRET-正文-不得外泄';
  try {
    const created = await ctl(['create', ...data, '--cwd', base, '--origin', 'my-bot', '--', process.execPath, fixture, 'fixture'], '', env);
    assert.equal(created.code, 0);
    const { sessionId, instanceId, pid } = created.json.session;
    assert.ok(sessionId && instanceId && pid > 1);
    const ids = ['--session', sessionId, '--instance', instanceId];
    const agent = await until(async () => {
      const listed = (await ctl(['list', ...data], '', env)).json.sessions.find((s: any) => s.sessionId === sessionId);
      return listed?.foreground?.pid as number | undefined;
    });
    const listed = (await ctl(['list', ...data], '', env)).json;
    assert.equal(listed.ok, true);
    assert.equal(listed.sessions[0].origin, 'my-bot');
    await until(async () => (await ctl(['screen', ...data, ...ids], '', env)).json.text.includes('READY:') || undefined);
    const expect = ['--expect-pid', String(agent)];
    assert.deepEqual((await ctl(['text', ...data, ...ids, ...expect], 'hello', env)).json, { ok: true });
    assert.deepEqual((await ctl(['key', ...data, ...ids, ...expect, '--key', 'Enter'], '', env)).json, { ok: true });
    const screen = await until(async () => {
      const run = await ctl(['screen', ...data, ...ids, '--lines', '5', '--no-join'], '', env);
      return run.json.text.includes('INPUT:hello') ? run : undefined;
    });
    assert.deepEqual(Object.keys(screen.json).sort(), ['alternate', 'ok', 'text']);
    // The text never appears in argv by construction; it must not reach stderr or the log either.
    const sent = await ctl(['text', ...data, ...ids, ...expect], secret, env);
    const refused = await ctl(['text', ...data, ...ids, '--expect-pid', String(agent + 100_000)], secret, env);
    assert.deepEqual([sent.json.ok, refused.code, refused.json.code], [true, 1, 'rejected']);
    for (const run of [sent, refused]) { assert.doesNotMatch(run.stderr + run.stdout, /SECRET/); }
    const log = await readFile(path.join(dir, 'daemon.log'), 'utf8').catch(() => '');
    assert.doesNotMatch(log, /SECRET/);
    const stale = await ctl(['key', ...data, '--session', sessionId, '--instance', 'old', ...expect, '--key', 'Enter'], '', env);
    assert.deepEqual([stale.code, stale.json.code], [1, 'stale']);
    assert.deepEqual((await ctl(['close', ...data, ...ids, ...expect], '', env)).json, { ok: true });
    await until(async () => (await ctl(['list', ...data], '', env)).json.sessions[0].alive === false || undefined);
    assert.equal((await ctl(['screen', ...data, ...ids], '', env)).json.code, 'stale');
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('every subcommand reports unavailable without a daemon and never starts one', async () => {
  const dir = await directory();
  try {
    const ids = ['--session', 's', '--instance', 'i'];
    for (const args of [['list'], ['screen', ...ids], ['text', ...ids, '--expect-pid', '1234'], ['key', ...ids, '--expect-pid', '1234', '--key', 'Enter'],
      ['create', '--cwd', base, '--', '/bin/sh'], ['close', ...ids, '--expect-pid', '1234']]) {
      const [sub, ...rest] = args;
      const run = await ctl([sub, '--data-dir', dir, ...rest], 'text');
      assert.deepEqual([run.code, run.json.ok, run.json.code], [1, false, 'unavailable'], sub);
    }
    assert.deepEqual(await readdir(dir), [], 'no socket, token or log was created');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an older daemon that does not know remote requests is reported as unsupported', async () => {
  const dir = await directory();
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const frame = JSON.parse(buffer.slice(0, index)) as { id: string };
        buffer = buffer.slice(index + 1);
        socket.write(JSON.stringify({ v: VERSION, type: 'result', id: frame.id, ok: false, error: 'unknown request type' }) + '\n');
      }
    });
  });
  server.listen(path.join(dir, 'daemon.sock'));
  await once(server, 'listening');
  try {
    const list = await ctl(['list', '--data-dir', dir]);
    const create = await ctl(['create', '--data-dir', dir, '--cwd', base, '--', '/bin/sh']);
    assert.deepEqual([list.json.code, create.json.code, list.code], ['unsupported', 'unsupported', 1]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('argument errors are JSON with code invalid, checked before connecting', async () => {
  const ids = ['--session', 's', '--instance', 'i', '--expect-pid', '1234'];
  const cases: [string[], string][] = [
    [['bogus'], ''], [['key', ...ids, '--key', 'Up', '--key', 'Tab'], ''], [['key', ...ids], ''],
    [['text', ...ids, 'inline-text'], 'x'], [['text', ...ids], ''], [['text', '--session', 's', '--instance', 'i'], 'x'],
    [['screen', '--session', 's', '--instance', 'i', '--lines', '2001'], ''], [['screen', '--session', 's', '--instance', 'i', '--lines', '0'], ''],
    [['create', '--cwd', 'relative', '--', '/bin/sh'], ''], [['create', '--cwd', base, '--origin', 'Bad_Origin', '--', '/bin/sh'], ''],
    [['create', '--cwd', base], ''], [['list', '--data-dir', 'relative'], ''],
  ];
  for (const [args, stdin] of cases) {
    const run = await ctl(args, stdin);
    assert.deepEqual([run.code, run.json.ok, run.json.code], [1, false, 'invalid'], args.join(' '));
  }
  const oversized = await ctl(['text', ...ids], 'x'.repeat(1024 * 1024 + 1));
  assert.equal(oversized.json.code, 'invalid');
});
