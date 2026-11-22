import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { Daemon } from '../../daemon/src/server.ts';
import { VERSION } from '../../protocol/src/index.ts';
import { daemonEnv, runBridge, type BridgeHeader } from './bridge.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, '.tmp/app-m0-validation');

// Reads newline-delimited JSON written by the bridge to its stdout.
function lines(stream: PassThrough): () => Promise<unknown> {
  let buffer = '';
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const next = waiting.shift();
      if (next) next(line); else queue.push(line);
    }
  });
  return () => new Promise(resolve => {
    const line = queue.shift();
    if (line !== undefined) resolve(JSON.parse(line));
    else waiting.push(value => resolve(JSON.parse(value)));
  });
}

test('bridge reports its header, then carries daemon frames unchanged until stdin ends', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'b-'));
  const daemon = new Daemon(dir);
  await daemon.start();
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lines(stdout);
    let started = 0;
    const done = runBridge({ version: '0.1.0', dataDir: dir, stdin, stdout, startDaemon: () => { started++; } });
    const header = await next() as BridgeHeader;
    assert.equal(started, 0, 'a running daemon is not started again');
    assert.deepEqual([header.tarmacBridge, header.version, header.protocol, header.daemon], [1, '0.1.0', VERSION, 'running']);
    assert.equal(typeof header.shell.command, 'string');
    assert.ok(Array.isArray(header.shell.args));
    stdin.write(JSON.stringify({ v: VERSION, id: 'r1', type: 'list' }) + '\n');
    assert.deepEqual(await next(), { v: VERSION, type: 'result', id: 'r1', ok: true, value: [] });
    stdin.write(JSON.stringify({ v: VERSION, id: 'r2', type: 'workspace', paths: [root, path.join(dir, 'missing')] }) + '\n');
    const facts = await next() as { value: { path: string; exists: boolean; branch: string }[] };
    assert.deepEqual(facts.value.map(fact => fact.exists), [true, false]);
    stdin.end();
    await done;
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('bridge starts a daemon that is not running and waits for its socket', async () => {
  await mkdir(base, { recursive: true });
  const parent = await mkdtemp(path.join(base, 'b-'));
  const dir = path.join(parent, 'data');
  let daemon: Daemon | undefined;
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lines(stdout);
    const done = runBridge({ version: '0.1.0', dataDir: dir, stdin, stdout,
      startDaemon: dataDir => { daemon = new Daemon(dataDir); void daemon.start(); } });
    assert.equal((await next() as BridgeHeader).daemon, 'started');
    stdin.end();
    await done;
  } finally { await daemon?.stop(); await rm(parent, { recursive: true, force: true }); }
});

test('bridge fails when the daemon it started never listens', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'b-'));
  try {
    await assert.rejects(runBridge({ version: '0.1.0', dataDir: dir, stdin: new PassThrough(), stdout: new PassThrough(),
      startDaemon: () => {}, startTimeoutMs: 300 }), /daemon did not start/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a daemon started by the bridge does not inherit what names the connecting machine', () => {
  assert.deepEqual(daemonEnv({ HOME: '/home/dev', PATH: '/usr/bin', LANG: 'zh_CN.UTF-8', SSH_CLIENT: '192.168.1.30 51234 22',
    SSH_CONNECTION: '192.168.1.30 51234 192.168.1.20 22', SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1', TARMAC_SESSION_ID: 'old' }),
  { HOME: '/home/dev', PATH: '/usr/bin', LANG: 'zh_CN.UTF-8' });
});
