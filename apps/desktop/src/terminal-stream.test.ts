import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalStream } from './terminal-stream.ts';
import type { StreamTerminal } from './terminal-stream.ts';
import type { ServerEvent } from '../../../packages/protocol/src/index.ts';

const identity = { sessionId: 'pty-one', instanceId: 'run-one' };
const base64 = (value: string): string => Buffer.from(value).toString('base64');
const snapshot = (seq = 10, target = seq): Extract<ServerEvent, { type: 'snapshot' }> => ({ v: 1, type: 'snapshot', ...identity, seq, cols: 80, rows: 24, data: base64('快照'), target, exact: true });

test('snapshot parsing and ack complete before enabling input or applying incrementals', async () => {
  const calls: string[] = [];
  const callbacks: (() => void)[] = [];
  const stream = new TerminalStream({
    create(cols, rows) {
      calls.push(`create:${cols}:${rows}`);
      return {
        cols, rows,
        write(data, callback) { calls.push(`write:${Buffer.from(data).toString()}`); callbacks.push(callback); },
        resize(nextCols, nextRows) { calls.push(`resize:${nextCols}:${nextRows}`); },
        dispose() { calls.push('dispose'); },
      } satisfies StreamTerminal;
    },
    acknowledge: async (_identity, seq) => { calls.push(`ack:${seq}`); },
    ready: value => { calls.push(`ready:${value}`); },
    fault: error => { throw error; },
  });
  stream.prepare(identity);
  const restore = stream.receive(snapshot());
  const output = stream.receive({ v: 1, type: 'output', ...identity, first: 11, seq: 11, data: base64('增量') });
  const resize = stream.receive({ v: 1, type: 'resize', ...identity, seq: 12, cols: 90, rows: 30 });
  await Promise.resolve();
  assert.equal(stream.acceptsInput(), false);
  assert.deepEqual(calls.slice(-2), ['create:80:24', 'write:快照']);
  callbacks.shift()!();
  await restore;
  assert.equal(stream.acceptsInput(), true);
  await Promise.resolve();
  assert.equal(calls.at(-1), 'write:增量');
  callbacks.shift()!();
  await Promise.all([output, resize]);
  assert.deepEqual(calls.slice(-4), ['write:增量', 'ack:11', 'resize:90:30', 'ack:12']);
  stream.dispose();
});

test('sequence gaps disable input and stale process events cannot mutate the terminal', async () => {
  const writes: string[] = [];
  const faults: string[] = [];
  const stream = new TerminalStream({
    create(cols, rows) { return {
      cols, rows,
      write(data, callback) { writes.push(Buffer.from(data).toString()); callback(); },
      resize() {}, dispose() {},
    }; },
    acknowledge: async () => {},
    ready: () => {},
    fault: error => { faults.push(error.message); },
  });
  stream.prepare(identity);
  await stream.receive(snapshot());
  await stream.receive({ v: 1, type: 'output', ...identity, instanceId: 'old-run', first: 11, seq: 11, data: base64('旧进程') });
  assert.deepEqual(writes, ['快照']);
  await stream.receive({ v: 1, type: 'output', ...identity, first: 12, seq: 12, data: base64('缺失前序') });
  assert.equal(stream.acceptsInput(), false);
  assert.equal(faults.length, 1);
  assert.deepEqual(writes, ['快照']);
  stream.prepare(identity);
  await stream.receive(snapshot(20));
  assert.equal(stream.acceptsInput(), true);
  stream.dispose();
});

test('disconnect during asynchronous restore never enables input or acknowledges old snapshot', async () => {
  let finish: (() => void) | undefined;
  const acknowledgements: number[] = [];
  const stream = new TerminalStream({
    create(cols, rows) { return { cols, rows, write(_data, callback) { finish = callback; }, resize() {}, dispose() {} }; },
    acknowledge: async (_identity, seq) => { acknowledgements.push(seq); },
    ready: () => {}, fault: error => { throw error; },
  });
  stream.prepare(identity);
  const restore = stream.receive(snapshot());
  await Promise.resolve();
  stream.disconnect();
  finish!();
  await restore;
  assert.equal(stream.acceptsInput(), false);
  assert.deepEqual(acknowledgements, []);
  stream.dispose();
});

test('input stays disabled until merged replay frames reach the attach-time target', async () => {
  const writes: string[] = [];
  const acknowledgements: number[] = [];
  const readiness: boolean[] = [];
  const faults: string[] = [];
  const stream = new TerminalStream({
    create(cols, rows) { return { cols, rows, write(data, callback) { writes.push(Buffer.from(data).toString()); callback(); }, resize() {}, dispose() {} }; },
    acknowledge: async (_identity, seq) => { acknowledgements.push(seq); },
    ready: value => { readiness.push(value); }, fault: error => { faults.push(error.message); },
  });
  stream.prepare(identity);
  await stream.receive({ ...snapshot(0, 5), data: '' });
  assert.equal(stream.acceptsInput(), false);
  await stream.receive({ v: 1, type: 'output', ...identity, first: 1, seq: 3, data: base64('回放') });
  assert.equal(stream.acceptsInput(), false);
  await stream.receive({ v: 1, type: 'resize', ...identity, seq: 4, cols: 90, rows: 30 });
  await stream.receive({ v: 1, type: 'output', ...identity, first: 5, seq: 5, data: base64('末尾') });
  assert.equal(stream.acceptsInput(), true);
  assert.deepEqual(writes, ['回放', '末尾'], 'an empty base is not written');
  assert.deepEqual(acknowledgements, [0, 3, 4, 5]);
  assert.deepEqual(readiness, [false, false, true]);
  await stream.receive({ v: 1, type: 'output', ...identity, first: 7, seq: 8, data: base64('跳号') });
  assert.equal(stream.acceptsInput(), false);
  assert.deepEqual(faults, ['终端输出序号不连续，需要重新同步']);
  stream.dispose();
});

test('switching during an unfinished write discards old acknowledgements and binds the new terminal identity', async () => {
  const acknowledgements: string[] = [];
  const created: string[] = [];
  const writes: string[] = [];
  let finishOld: (() => void) | undefined;
  const next = { sessionId: 'pty-two', instanceId: 'run-two' };
  const stream = new TerminalStream({
    create(cols, rows, owner) {
      created.push(owner.sessionId);
      return { cols, rows, write(data, callback) {
        writes.push(owner.sessionId + ':' + Buffer.from(data).toString());
        if (owner.sessionId === identity.sessionId) finishOld = callback; else callback();
      }, resize() {}, dispose() {} };
    },
    acknowledge: async owner => { acknowledgements.push(owner.sessionId); },
    ready() {}, fault(error) { throw error; },
  });
  stream.prepare(identity);
  const oldWrite = stream.receive(snapshot());
  await Promise.resolve();
  stream.prepare(next);
  const stale = stream.receive({ ...snapshot(), data: base64('late-old-output') });
  const restored = stream.receive({ ...snapshot(0), ...next, data: base64('new-output') });
  finishOld!();
  await Promise.all([oldWrite, stale, restored]);
  assert.deepEqual(created, [identity.sessionId, next.sessionId]);
  assert.deepEqual(acknowledgements, [next.sessionId]);
  assert.deepEqual(writes, [identity.sessionId + ':快照', next.sessionId + ':new-output']);
  assert.equal(stream.acceptsInput(), true);
  stream.dispose();
});

test('a split replay base is written part by part and enables input only after its last part', async () => {
  const calls: string[] = [];
  const faults: string[] = [];
  const stream = new TerminalStream({
    create: (cols, rows) => ({ cols, rows, write(data, callback) { calls.push(`write:${Buffer.from(data).toString()}`); callback(); }, resize() {}, dispose() {} }),
    acknowledge: async (_identity, seq, part) => { calls.push(part === undefined ? `ack:${seq}` : `ack:${seq}:${part}`); },
    ready: value => { if (value) calls.push('ready'); },
    fault: error => { faults.push(error.message); },
  });
  stream.prepare(identity);
  const part = (index: number, text: string) => ({ v: 1, type: 'snapshot-part' as const, ...identity, seq: 10, part: index, data: base64(text) });
  // A multi-byte character split across parts is reassembled by the terminal's decoder.
  const bytes = Buffer.from('前半中文后半');
  const first = { ...snapshot(10, 11), data: bytes.subarray(0, 4).toString('base64'), parts: 3 };
  void stream.receive(first);
  void stream.receive({ ...part(1, ''), data: bytes.subarray(4, 10).toString('base64') });
  await stream.receive({ ...part(2, ''), data: bytes.subarray(10).toString('base64') });
  assert.equal(stream.acceptsInput(), false, 'records after the base are still pending');
  await stream.receive({ v: 1, type: 'output', ...identity, first: 11, seq: 11, data: base64('增量') });
  assert.equal(stream.acceptsInput(), true);
  assert.deepEqual(calls.filter(call => call.startsWith('ack') || call === 'ready'), ['ack:10:0', 'ack:10:1', 'ack:10:2', 'ack:11', 'ready']);
  assert.deepEqual(faults, []);

  // Output before the base is complete, or a part out of order, is a stream fault.
  stream.prepare(identity);
  await stream.receive({ ...snapshot(10), parts: 2 });
  await stream.receive({ v: 1, type: 'output', ...identity, first: 11, seq: 11, data: base64('早到') });
  assert.match(faults.at(-1)!, /尚未接收完整/);
  stream.prepare(identity);
  await stream.receive({ ...snapshot(10), parts: 3 });
  await stream.receive(part(2, 'x'));
  assert.match(faults.at(-1)!, /分片不连续/);
  stream.dispose();
});
