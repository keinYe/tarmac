import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalStream } from './terminal.ts';
import { ReplayLog, createTerminal, replayInto, terminalState } from './replay.ts';
import { applyFrames, restore, write } from '../test/restore.ts';

const identity = { sessionId: 'replay-test', instanceId: 'run' };
const small = { compactBytes: 16 * 1024, retryBytes: 8 * 1024, maxBytes: 96 * 1024 };
const filler = (bytes: number) => Buffer.from('\x1b[32mfiller 中文\x1b[0m line\r\n'.repeat(Math.ceil(bytes / 32)));

test('replay log merges consecutive output, keeps resize ordered and refuses cursors before the base', () => {
  const log = new ReplayLog({ seq: 0, cols: 80, rows: 24, data: '', exact: true });
  log.append({ seq: 1, kind: 'output', data: Buffer.from('ab') });
  log.append({ seq: 2, kind: 'output', data: Buffer.from('cd') });
  log.append({ seq: 3, kind: 'resize', cols: 90, rows: 30 });
  log.append({ seq: 4, kind: 'output', data: Buffer.from('ef') });
  assert.throws(() => log.append({ seq: 6, kind: 'output', data: Buffer.from('x') }), /gap/);
  assert.deepEqual(log.read(0, 1024, 10)!.map(frame => frame.kind === 'output' ? [frame.first, frame.seq, frame.data.toString()] : [frame.seq, frame.cols]),
    [[1, 2, 'abcd'], [3, 90], [4, 4, 'ef']]);
  assert.deepEqual(log.read(0, 3, 10)!.map(frame => frame.seq), [1, 2, 3, 4], 'frame limit splits merged output');
  assert.deepEqual(log.read(0, 1024, 1)!.length, 1);
  assert.deepEqual(log.read(4, 1024, 10), []);
  assert.equal(log.bytes, 6);
  log.rebase({ seq: 2, cols: 80, rows: 24, data: 'abcd', exact: true });
  assert.equal(log.bytes, 2);
  assert.equal(log.read(1, 1024, 10), undefined);
  assert.deepEqual(log.read(2, 1024, 10)!.map(frame => frame.seq), [3, 4]);
});

test('verified compaction moves the base and replay stays identical before and after continuing', async () => {
  let changed = 0;
  const stream = new TerminalStream(identity, 60, 10, { limits: small, changed: () => { changed++; } });
  try {
    await stream.write(Buffer.from('\x1b[2;5r\x1b[4;1Hscroll\x1b[r\x1b(0lqk\x1b(B\x1b[1;31mred\x1b[0m\r\n'));
    for (let i = 0; i < 4; i++) await stream.write(filler(8 * 1024));
    await stream.resize(70, 12);
    await stream.write(filler(4 * 1024));
    await stream.idle();
    const { terminal, seq, snapshot } = await restore(stream);
    try {
      assert.ok(snapshot.seq > 0, 'base moved past the start');
      assert.equal(snapshot.exact, true);
      assert.equal(stream.replay.lastCheckFailure, undefined);
      assert.ok(changed > 0);
      assert.ok(stream.logBytes < small.compactBytes + 16 * 1024);
      assert.equal(terminalState(terminal), terminalState(stream.terminal));
      await stream.write(Buffer.from('\x1b8\tX\x1b(0q'));
      await applyFrames(terminal, stream, seq);
      assert.equal(terminalState(terminal), terminalState(stream.terminal));
    } finally { terminal.dispose(); }
  } finally { stream.dispose(); }
});

for (const [name, prefix, suffix] of [
  ['scroll margins', 'one\r\ntwo\r\nthree\r\nfour\x1b[2;3r\x1b[3;1H', '\nNEW'],
  ['origin mode', '\x1b[3;8r\x1b[?6h\x1b[2;2Hcontent', '\x1b[6;1H\nNEXT'],
  ['tab stops', '\x1b[3g\x1b[1;5H\x1bH\x1b[1;1H', '\tX'],
  ['DEC saved cursor', '\x1b[2;3H\x1b[31m\x1b7\x1b[0m\x1b[4;8H', '\x1b8X'],
  ['SCO saved cursor', '\x1b[2;3H\x1b[s\x1b[4;8H', '\x1b[uX'],
  ['G0 charset', '\x1b(0lqk', 'q'],
  ['G1 charset and shift-out', '\x1b)0\x0elqk', 'q\x0fASCII'],
] as const) {
  test(`unverifiable ${name} keeps the full log so replay stays exact`, async () => {
    const stream = new TerminalStream(identity, 40, 12, { limits: { ...small, maxBytes: 1 << 20 } });
    try {
      await stream.write(Buffer.from(prefix));
      // Plain text keeps the hidden state in place while growing the log past the threshold.
      await stream.write(Buffer.from('x'.repeat(24 * 1024)));
      await stream.idle();
      assert.ok(stream.replay.lastCheckFailure, 'verification must notice the hidden state');
      const { terminal, seq, snapshot } = await restore(stream);
      try {
        assert.equal(snapshot.seq, 0);
        assert.equal(snapshot.exact, true);
        await stream.write(Buffer.from(suffix));
        await applyFrames(terminal, stream, seq);
        assert.equal(terminalState(terminal), terminalState(stream.terminal));
      } finally { terminal.dispose(); }
    } finally { stream.dispose(); }
  });
}

test('saved cursor that never clears degrades visibly at the hard limit and stays degraded', async () => {
  let changed = 0;
  const stream = new TerminalStream(identity, 60, 10, { limits: small, changed: () => { changed++; } });
  try {
    await stream.write(Buffer.from('\x1b[5;7H\x1b[31m\x1b7\x1b[0m\x1b[H'));
    await stream.write(filler(20 * 1024));
    await stream.idle();
    assert.equal(stream.replay.lastCheckFailure, 'DEC 保存光标');
    assert.equal(stream.replay.exact, true);
    for (let i = 0; i < 12 && stream.replay.exact; i++) { await stream.write(filler(8 * 1024)); await stream.idle(); }
    assert.equal(stream.replay.exact, false);
    assert.match(stream.replay.reason ?? '', /上限.*DEC 保存光标/);
    assert.ok(changed >= 2);
    assert.ok(stream.logBytes < small.maxBytes);
    for (let i = 0; i < 6; i++) await stream.write(filler(8 * 1024));
    await stream.idle();
    const { snapshot } = await restore(stream);
    assert.equal(snapshot.exact, false);
    assert.ok(stream.logBytes <= small.compactBytes + 8 * 1024, 'degraded logs still compact without verification');
  } finally { stream.dispose(); }
});

test('reference terminals used for verification never answer replayed queries', async () => {
  const replies: string[] = [];
  const stream = new TerminalStream(identity, 60, 10, { limits: small, reply: value => replies.push(value) });
  try {
    await stream.write(Buffer.from('\x1b[6n\x1b[c'));
    await stream.write(filler(24 * 1024));
    await stream.idle();
    const { terminal, snapshot } = await restore(stream);
    terminal.dispose();
    assert.ok(snapshot.seq > 0, 'compaction verified with the queries in its reference replay');
    assert.equal(replies.length, 2, 'only the authoritative terminal answered DSR and DA, once each');
  } finally { stream.dispose(); }
});

test('replaying a hard-limit log stays within the recovery time budget', async (t) => {
  const cols = 120;
  const rows = 40;
  const frame = Buffer.from(Array.from({ length: rows }, (_, row) =>
    `\x1b[${row + 1};1H\x1b[2K\x1b[38;2;10;${row};200m● 工作中 line ${row}\x1b[0m ${'abcdefghij'.repeat(8)}`).join(''));
  const log = new ReplayLog({ seq: 0, cols, rows, data: '', exact: true });
  for (let seq = 1; log.bytes < 32 * 1024 * 1024; seq++) log.append({ seq, kind: 'output', data: frame });
  const terminal = createTerminal(cols, rows);
  try {
    const start = performance.now();
    await replayInto(terminal, log.base, log.through(log.end));
    const elapsed = performance.now() - start;
    t.diagnostic(`replayed ${(log.bytes / 1048576).toFixed(1)} MiB in ${elapsed.toFixed(0)} ms`);
    assert.ok(elapsed <= 3000, `replay took ${elapsed.toFixed(0)} ms`);
    await write(terminal, '');
  } finally { terminal.dispose(); }
});

test('a read stops at its total budget so a subscriber far behind is paced', () => {
  const log = new ReplayLog({ seq: 0, cols: 80, rows: 24, data: '', exact: true });
  for (let seq = 1; seq <= 100; seq++) log.append({ seq, kind: 'output', data: Buffer.alloc(1000, 120) });
  const frames = log.read(0, 4000, 4096, 10_000)!;
  const bytes = frames.reduce((sum, frame) => sum + (frame.kind === 'output' ? frame.data.length : 0), 0);
  assert.ok(bytes >= 10_000 && bytes < 14_000, `read ${bytes} bytes`);
  assert.equal(log.read(0, 4000, 4096)!.reduce((sum, frame) => sum + (frame.kind === 'output' ? frame.data.length : 0), 0), 100_000, 'no total keeps the old behavior');
  assert.equal(log.read(0, 4000, 4096, 1)!.length, 1, 'at least one frame');
});
