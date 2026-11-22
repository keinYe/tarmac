import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Daemon } from './server.ts';
import { Client } from '../../protocol/src/client.ts';
import { VERSION } from '../../protocol/src/index.ts';
import { TOKEN_FILE } from '../../protocol/src/platform.ts';
import type { ServerEvent } from '../../protocol/src/index.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');

// The Windows handshake, exercised on any host by enabling it explicitly.
async function setup() {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'auth-'));
  const daemon = new Daemon(dir, { requireToken: true });
  await daemon.start();
  return { daemon, dir, async cleanup() { await daemon.stop(); await rm(dir, { recursive: true, force: true }); } };
}

function raw(socketPath: string) {
  const socket = net.createConnection(socketPath);
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; });
  socket.on('error', () => {});
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  return { socket, closed, received: () => received };
}

test('a token daemon publishes its token and serves an authenticated client', async () => {
  const t = await setup();
  try {
    assert.equal(t.daemon.token?.length, 64);
    assert.equal((await readFile(path.join(t.dir, TOKEN_FILE), 'utf8')).trim(), t.daemon.token);
    const client = await Client.connect(t.daemon.socketPath, 2000, t.daemon.token);
    try {
      const events: ServerEvent[] = [];
      client.on('event', event => events.push(event));
      assert.deepEqual(await client.request({ type: 'list' }), []);
      await client.request({ type: 'create', options: { command: '/bin/sh', args: ['-c', 'sleep 5'], cwd: t.dir, cols: 80, rows: 24 } });
      assert.ok(events.some(event => event.type === 'info'), 'authenticated peers receive broadcasts');
    } finally { client.close(); }
  } finally { await t.cleanup(); }
});

test('an unauthenticated peer receives nothing and is dropped on its first other request', async () => {
  const t = await setup();
  const authorized = await Client.connect(t.daemon.socketPath, 2000, t.daemon.token);
  const listener = raw(t.daemon.socketPath);
  try {
    await new Promise(resolve => listener.socket.once('connect', resolve));
    // A broadcast happens while the unauthenticated peer is connected.
    await authorized.request({ type: 'create', options: { command: '/bin/sh', args: ['-c', 'sleep 5'], cwd: t.dir, cols: 80, rows: 24 } });
    await delay(100);
    assert.equal(listener.received(), '', 'no frame reaches a peer before auth');
    listener.socket.write(JSON.stringify({ v: VERSION, id: '1', type: 'list' }) + '\n');
    await listener.closed;
    assert.equal(listener.received(), '');
  } finally { authorized.close(); listener.socket.destroy(); await t.cleanup(); }
});

test('a wrong token is rejected and the connection closed', async () => {
  const t = await setup();
  try {
    await assert.rejects(Client.connect(t.daemon.socketPath, 2000, '0'.repeat(64)), /authentication failed/);
    // Without auth the client connects, but its first request closes the connection.
    const client = await Client.connect(t.daemon.socketPath, 2000);
    await assert.rejects(client.request({ type: 'list' }), /daemon disconnected/);
  } finally { await t.cleanup(); }
});

test('POSIX daemons keep accepting clients without a token', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'auth-'));
  const daemon = new Daemon(dir, { requireToken: false });
  await daemon.start();
  try {
    assert.equal(daemon.token, undefined);
    await assert.rejects(readFile(path.join(dir, TOKEN_FILE)), { code: 'ENOENT' });
    const client = await Client.connect(daemon.socketPath);
    try {
      assert.deepEqual(await client.request({ type: 'list' }), []);
      assert.equal(await client.request({ type: 'auth', token: 'anything' }), null, 'auth is a no-op without a token');
    } finally { client.close(); }
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});
