import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Daemon } from './server.ts';
import { Client } from '../../protocol/src/client.ts';
import { LIMITS, SNAPSHOT_PART_CHARS } from '../../protocol/src/index.ts';
import type { ServerEvent, SessionInfo } from '../../protocol/src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, '.tmp/app-m0-validation');

async function waitFor(check: () => boolean | Promise<boolean>, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error('condition not reached');
}

// A compacted base larger than one frame used to be sent whole: encoding failed and the daemon
// closed the connection on every attach, so the App reconnected forever.
test('a replay base larger than one frame is sent in acknowledged parts', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'parts-'));
  // Small compaction thresholds make the base a serialized, colorful scrollback quickly.
  const daemon = new Daemon(dir, { replayLimits: { compactBytes: 256 * 1024, retryBytes: 128 * 1024, maxBytes: 64 * 1024 * 1024 } });
  await daemon.start();
  const control = await Client.connect(daemon.socketPath);
  const viewer = await Client.connect(daemon.socketPath);
  try {
    const info = await control.request<SessionInfo>({ type: 'create', options: { command: process.execPath,
      args: [path.join(root, 'packages/daemon/test/colorful.mjs'), '200', '200'], cwd: dir, cols: 200, rows: 40 } });
    const context = (daemon as unknown as { contexts: Map<string, { stream: { idle(): Promise<void>; log: { base: { data: string } };
      terminal: { buffer: { active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } } } } }> }).contexts.get(info.sessionId)!;
    // The fixture writes in chunks and prints COLORFUL-DONE last. Attaching before that line is
    // parsed let a later write compact the log again, replacing the base this test compares with.
    const done = () => {
      const lines = context.stream.terminal.buffer.active;
      for (let y = lines.length - 1; y >= Math.max(0, lines.length - 60); y--) if (lines.getLine(y)?.translateToString(true).includes('COLORFUL-DONE')) return true;
      return false;
    };
    await waitFor(async () => { await context.stream.idle(); return done(); });
    await context.stream.idle();
    assert.ok(Buffer.from(context.stream.log.base.data).toString('base64').length > 3 * SNAPSHOT_PART_CHARS, 'the compacted base spans several parts');
    const events: ServerEvent[] = [];
    let disconnected = false;
    viewer.on('event', event => events.push(event));
    viewer.on('disconnect', () => { disconnected = true; });
    const identity = { sessionId: info.sessionId, instanceId: info.instanceId };
    await viewer.request({ type: 'attach', ...identity });
    await waitFor(() => events.some(event => event.type === 'snapshot'));
    await delay(200);
    const first = events.find(event => event.type === 'snapshot') as Extract<ServerEvent, { type: 'snapshot' }>;
    assert.ok(first.parts && first.parts > 3, `expected a split base, got ${first.parts}`);
    const unacked = () => events.filter(event => event.type === 'snapshot' || event.type === 'snapshot-part');
    // Without acknowledgements the parts stop at the per-subscriber budget.
    assert.ok(unacked().reduce((sum, event) => sum + event.data.length * 3 / 4, 0) <= LIMITS.subscriberBytes + LIMITS.replayFrameBytes);
    assert.equal(events.some(event => event.type === 'output'), false, 'records wait for the whole base');
    await assert.rejects(viewer.request({ type: 'ack', ...identity, seq: first.seq, part: 1 }), /invalid snapshot acknowledgement/);
    await assert.rejects(viewer.request({ type: 'ack', ...identity, seq: first.seq }), /invalid output acknowledgement/);
    for (let part = 0; part < first.parts; part++) {
      await waitFor(() => unacked().length > part);
      await viewer.request({ type: 'ack', ...identity, seq: first.seq, part });
    }
    const parts = unacked();
    assert.deepEqual(parts.map(event => event.type === 'snapshot-part' ? event.part : 0), [...Array(first.parts).keys()]);
    for (const event of parts) assert.ok(event.data.length <= SNAPSHOT_PART_CHARS, 'every part fits one frame');
    assert.equal(parts.map(event => event.data).join(''), Buffer.from(context.stream.log.base.data).toString('base64'));
    // Records after the base follow, and input opens once they are acknowledged.
    let acked = first.seq;
    await waitFor(async () => {
      for (const event of events) if ((event.type === 'output' || event.type === 'resize') && event.seq > acked) {
        acked = event.seq;
        await viewer.request({ type: 'ack', ...identity, seq: acked });
      }
      return acked >= first.target;
    });
    await viewer.request({ type: 'input', ...identity, data: 'after-parts\r' });
    await waitFor(() => events.some(event => event.type === 'output' && Buffer.from(event.data, 'base64').toString().includes('INPUT:after-parts')));
    assert.equal(disconnected, false);
  } finally {
    viewer.close(); control.close();
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// Records after the base were read in one call regardless of the unacknowledged budget, so
// attaching to a session with a large uncompacted log wrote it all at once and was cut off.
test('a subscriber far behind receives its backlog paced by acknowledgements', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'pace-'));
  // No compaction: the whole output stays as records after an empty base, like a log whose
  // verification keeps failing.
  const daemon = new Daemon(dir, { replayLimits: { compactBytes: 1 << 30, retryBytes: 1 << 30, maxBytes: 1 << 30 } });
  await daemon.start();
  const control = await Client.connect(daemon.socketPath);
  const viewer = await Client.connect(daemon.socketPath);
  try {
    const info = await control.request<SessionInfo>({ type: 'create', options: { command: process.execPath,
      args: [path.join(root, 'packages/daemon/test/colorful.mjs'), '200', '1800'], cwd: dir, cols: 200, rows: 40 } });
    const context = (daemon as unknown as { contexts: Map<string, { stream: { idle(): Promise<void>; logBytes: number } }> }).contexts.get(info.sessionId)!;
    await waitFor(async () => { await context.stream.idle(); return context.stream.logBytes > LIMITS.frameBytes + (2 << 20); });
    const events: ServerEvent[] = [];
    let disconnected = false;
    viewer.on('event', event => events.push(event));
    viewer.on('disconnect', () => { disconnected = true; });
    const identity = { sessionId: info.sessionId, instanceId: info.instanceId };
    await viewer.request({ type: 'attach', ...identity });
    await delay(300);
    const outputBytes = () => events.reduce((sum, event) => sum + (event.type === 'output' ? event.data.length * 3 / 4 : 0), 0);
    assert.equal(disconnected, false, 'attaching to a large log keeps the connection');
    assert.ok(outputBytes() <= LIMITS.subscriberBytes + LIMITS.replayFrameBytes, `sent ${outputBytes()} bytes without acknowledgement`);
    const first = events.find(event => event.type === 'snapshot') as Extract<ServerEvent, { type: 'snapshot' }>;
    let acked = first.seq;
    await viewer.request({ type: 'ack', ...identity, seq: acked });
    await waitFor(async () => {
      for (const event of events) if ((event.type === 'output' || event.type === 'resize') && event.seq > acked) {
        acked = event.seq;
        await viewer.request({ type: 'ack', ...identity, seq: acked });
      }
      return acked >= first.target;
    });
    assert.ok(outputBytes() > LIMITS.frameBytes, 'the whole backlog arrived');
    assert.equal(disconnected, false);
  } finally {
    viewer.close(); control.close();
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('reasons for closing a connection are written to daemon.log', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'log-'));
  const daemon = new Daemon(dir);
  await daemon.start();
  try {
    const client = await Client.connect(daemon.socketPath);
    const socket = (client as unknown as { socket: import('node:net').Socket }).socket;
    const closed = new Promise(resolve => client.once('disconnect', resolve));
    socket.write('not json\n');
    await closed;
    await waitFor(async () => (await readFile(path.join(dir, 'daemon.log'), 'utf8').catch(() => '')).includes('closed connection: invalid request'));
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});
