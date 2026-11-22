import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { TerminalStream } from './terminal.ts';
import { restore as replay, snapshotOf, write } from '../test/restore.ts';

type Terminal = InstanceType<typeof headless.Terminal>;
function fingerprint(term: Terminal): unknown {
  const buffer = term.buffer.active;
  return {
    cols: term.cols, rows: term.rows, type: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
    baseY: buffer.baseY, modes: term.modes,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index)!;
      return { wrapped: line.isWrapped, cells: Array.from({ length: line.length }, (_, column) => {
        const cell = line.getCell(column)!;
        return [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
          Boolean(cell.isBold()), Boolean(cell.isItalic()), Boolean(cell.isUnderline()), Boolean(cell.isInverse())];
      }) };
    }),
  };
}

async function restore(stream: TerminalStream): Promise<Terminal> {
  return (await replay(stream)).terminal;
}

test('10 MiB output and 30 reconnects preserve cells, colors, wrapping, cursor and modes with resize', async () => {
  const stream = new TerminalStream({ sessionId: 'test', instanceId: 'run' }, 80, 24);
  let total = 0;
  try {
    for (let i = 0; i < 30; i++) {
      const data = Buffer.from((`line-${i} 中文\x1b[1;38;2;1;2;3m colored\x1b[0m abcdefghijklmnopqrstuvwxyz\r\n`).repeat(5200));
      total += data.length;
      await stream.write(data);
      await stream.resize(i % 2 ? 80 : 100, 24);
      const mirror = await restore(stream);
      try { assert.deepEqual(fingerprint(mirror), fingerprint(stream.terminal)); }
      finally { mirror.dispose(); }
    }
    assert.ok(total >= 10 * 1024 * 1024, `only ${total} bytes`);
  } finally { stream.dispose(); }
});

test('split UTF-8, CSI, OSC and DCS cross snapshot boundaries without duplicating data or replies', async () => {
  const replies: string[] = [];
  const stream = new TerminalStream({ sessionId: 'test', instanceId: 'run' }, 80, 24, {
    reply: value => replies.push(value),
  });
  try {
    const chunks = [Buffer.from('before\x1b[3'), Buffer.from('1m红色\x1b]0;part'), Buffer.from('ial\x07\x1bP$q'),
      Buffer.from('m\x1b\\\x1b[6n\x1b[?2004h\x1b[?1004h\x1b[?1006h\x1b[?1000h\x1b[?1h'), Buffer.from('中').subarray(0, 2), Buffer.from('中').subarray(2)];
    for (const chunk of chunks) {
      await stream.write(chunk);
      const mirror = await restore(stream);
      try { assert.deepEqual(fingerprint(mirror), fingerprint(stream.terminal)); }
      finally { mirror.dispose(); }
    }
    const emitted = Buffer.concat(stream.read(0, 1 << 20, 4096)!.flatMap(({ event }) => event.type === 'output' ? [Buffer.from(event.data, 'base64')] : []));
    assert.deepEqual(emitted, Buffer.concat(chunks));
    assert.equal(replies.length, 2, 'only authoritative headless responds to DCS and DSR queries');
    assert.equal(stream.pendingBytes, 0);
  } finally { stream.dispose(); }
});

test('alternate screen and normal history survive reconnect', async () => {
  const stream = new TerminalStream({ sessionId: 'test', instanceId: 'run' }, 80, 24);
  try {
    await stream.write(Buffer.from('normal\r\n'.repeat(40) + '\x1b[?1049halt-screen\x1b[4;9Hcursor'));
    const mirror = await restore(stream);
    try {
      assert.deepEqual(fingerprint(mirror), fingerprint(stream.terminal));
      await stream.write(Buffer.from('\x1b[?1049l'));
      await write(mirror, '\x1b[?1049l');
      assert.deepEqual(fingerprint(mirror), fingerprint(stream.terminal));
    } finally { mirror.dispose(); }
  } finally { stream.dispose(); }
});

test('replay base barrier fixes the target before later output and parser high water applies backpressure', async () => {
  const flow: boolean[] = [];
  let appended = 0;
  const stream = new TerminalStream({ sessionId: 'test', instanceId: 'run' }, 80, 24, {
    appended: () => { appended++; }, flow: paused => flow.push(paused),
  });
  try {
    const first = stream.write(Buffer.from('a'));
    const barrier = snapshotOf(stream);
    const last = stream.write(Buffer.from('b'));
    const [, snapshot] = await Promise.all([first, barrier, last]);
    assert.deepEqual([snapshot.seq, snapshot.target, snapshot.data], [0, 1, '']);
    assert.equal(appended, 2);
    assert.deepEqual(stream.read(1, 1 << 20, 10)!.map(({ event }) => [event.type, event.seq]), [['output', 2]]);
    const writes = Array.from({ length: 20 }, () => stream.write(Buffer.from('x'.repeat(65536))));
    await Promise.all(writes);
    assert.deepEqual(flow, [true, false]);
  } finally { stream.dispose(); }
});
