import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from './client.ts';
import type { RequestFrame } from './index.ts';
import { encodeFrame, VERSION } from './index.ts';

async function fixture(t: import('node:test').TestContext, handle: (socket: net.Socket, frame: RequestFrame) => void): Promise<Client> {
  const root = path.resolve('.tmp/app-m0-validation');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'c-'));
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handle(socket, JSON.parse(line) as RequestFrame);
      }
    });
  });
  const socketPath = path.join(dir, 'd.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const client = await Client.connect(socketPath);
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return client;
}

function reply(socket: net.Socket, frame: RequestFrame, value: unknown): void {
  socket.write(encodeFrame({ v: VERSION, type: 'result', id: frame.id, ok: true, value }));
}

test('waiting for daemon shutdown is bounded, leaves a timed-out connection usable and handles prior disconnect', async t => {
  let closeNext = false;
  const client = await fixture(t, (socket, frame) => {
    reply(socket, frame, 'ready');
    if (closeNext) socket.end();
  });
  await assert.rejects(client.waitForDisconnect(15), /shutdown timeout/);
  assert.equal(client.listenerCount('disconnect'), 0);
  assert.equal(await client.request({ type: 'list' }), 'ready');
  const ended = client.waitForDisconnect(1000);
  closeNext = true;
  await client.request({ type: 'list' });
  await ended;
  await client.waitForDisconnect(15);
  assert.equal(client.listenerCount('disconnect'), 0);
});

test('100 simultaneous short input requests are sent in order with at most eight in flight', async t => {
  let inFlight = 0;
  let peak = 0;
  const received: string[] = [];
  const client = await fixture(t, (socket, frame) => {
    assert.equal(frame.type, 'input');
    if (frame.type !== 'input') return;
    received.push(frame.data);
    peak = Math.max(peak, ++inFlight);
    setTimeout(() => { inFlight--; reply(socket, frame, frame.data); }, 5);
  });
  const values = Array.from({ length: 100 }, (_, index) => String(index));
  const result = await Promise.all(values.map(data => client.request<string>({ type: 'input', sessionId: 's', instanceId: 'i', data })));
  assert.deepEqual(result, values);
  assert.deepEqual(received, values);
  assert.ok(peak <= 8 && peak > 1, `peak in-flight ${peak}`);
  assert.equal(await client.request({ type: 'input', sessionId: 's', instanceId: 'i', data: 'still-connected' }), 'still-connected');
});

test('queue holds at most 1024 waiting requests and close rejects every accepted promise', async t => {
  let received = 0;
  const client = await fixture(t, () => { received++; });
  const pending = Array.from({ length: 1032 }, () => client.request({ type: 'list' }));
  const results = Promise.allSettled(pending);
  await assert.rejects(client.request({ type: 'list' }), /queue exceeds limit/);
  await delay(20);
  assert.equal(received, 8);
  client.close();
  assert.ok((await results).every(result => result.status === 'rejected'));
  await assert.rejects(client.request({ type: 'list' }), /disconnected/);
});

test('total encoded request frames are bounded to 16 MiB and budget is released after replies', async t => {
  const waiting: { socket: net.Socket; frame: RequestFrame }[] = [];
  const client = await fixture(t, (socket, frame) => waiting.push({ socket, frame }));
  const large = 'x'.repeat(6 * 1024 * 1024);
  const request = { type: 'input', sessionId: 's', instanceId: 'i', data: large } as const;
  const first = client.request(request);
  const second = client.request(request);
  await assert.rejects(client.request(request), /buffer exceeds limit/);
  for (let i = 0; waiting.length < 2 && i < 100; i++) await delay(5);
  assert.equal(waiting.length, 2);
  for (const entry of waiting.splice(0)) reply(entry.socket, entry.frame, true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const third = client.request(request);
  for (let i = 0; !waiting.length && i < 100; i++) await delay(5);
  assert.equal(waiting.length, 1);
  reply(waiting[0].socket, waiting[0].frame, true);
  assert.equal(await third, true);
});

test('an unsent request can time out without sending it or closing unrelated requests', async t => {
  const waiting: { socket: net.Socket; frame: RequestFrame }[] = [];
  const client = await fixture(t, (socket, frame) => waiting.push({ socket, frame }));
  const busy = Array.from({ length: 8 }, () => client.request({ type: 'list' }));
  await assert.rejects(client.request({ type: 'list' }, 15), /timeout before send/);
  assert.equal(waiting.length, 8);
  for (const entry of waiting.splice(0)) reply(entry.socket, entry.frame, true);
  assert.ok((await Promise.all(busy)).every(Boolean));
  const next = client.request({ type: 'list' });
  for (let i = 0; !waiting.length && i < 100; i++) await delay(5);
  reply(waiting[0].socket, waiting[0].frame, true);
  assert.equal(await next, true);
});

test('an in-flight timeout closes the connection and rejects in-flight and queued requests', async t => {
  const client = await fixture(t, () => {});
  const first = client.request({ type: 'list' }, 15);
  const others = Array.from({ length: 30 }, () => client.request({ type: 'list' }, 5000));
  const settled = Promise.allSettled([first, ...others]);
  assert.ok((await settled).every(result => result.status === 'rejected'));
  await assert.rejects(client.request({ type: 'list' }), /disconnected/);
});

test('daemon disconnect rejects all accepted requests', async t => {
  const client = await fixture(t, socket => socket.destroy());
  const settled = await Promise.allSettled(Array.from({ length: 50 }, () => client.request({ type: 'list' })));
  assert.ok(settled.every(result => result.status === 'rejected'));
});
