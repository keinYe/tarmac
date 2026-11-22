import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { TerminalStream } from './terminal.ts';
import { applyFrames, restore, write } from '../test/restore.ts';

type Terminal = InstanceType<typeof headless.Terminal>;
function allOutput(stream: TerminalStream): Buffer {
  return Buffer.concat(stream.read(0, 1 << 20, 4096)!.flatMap(({ event }) => event.type === 'output' ? [Buffer.from(event.data, 'base64')] : []));
}
function screen(terminal: Terminal): unknown {
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, row) => {
    const line = buffer.getLine(row)!;
    return Array.from({ length: terminal.cols }, (_, col) => {
      const cell = line.getCell(col)!;
      return [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
        cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isUnderline(), cell.isInverse()];
    });
  });
  return { lines, cursorX: buffer.cursorX, cursorY: buffer.cursorY, type: buffer.type, modes: terminal.modes };
}

test('C1 CSI snapshot boundary restores color and text instead of leaking a partial command', async () => {
  const stream = new TerminalStream({ sessionId: 's', instanceId: 'i' }, 20, 4);
  let restored: Terminal | undefined;
  try {
    await stream.write(Buffer.from('\u009b31'));
    assert.equal(stream.pendingBytes, Buffer.byteLength('\u009b31'));
    const replay = await restore(stream);
    restored = replay.terminal;
    await stream.write(Buffer.from('mRED'));
    await applyFrames(restored, stream, replay.seq);
    assert.equal(stream.terminal.buffer.active.getLine(0)!.translateToString(true), 'RED');
    assert.deepEqual(screen(restored), screen(stream.terminal));
    assert.equal(restored.buffer.active.getLine(0)!.getCell(0)!.getFgColor(), 1);
  } finally { stream.dispose(); restored?.dispose(); }
});

test('reconnects across every byte of C1 strings and cancellations preserve bytes and terminal interpretation', async () => {
  for (const sequence of [
    '\u009d0;中文\u009cAFTER', '\u0090$qdata\u009cAFTER',
    '\u0098ignored\u009cAFTER', '\u009eignored\u009cAFTER', '\u009fignored\u009cAFTER',
    '\u009d0;cancel\x18AFTER', '\u0090$qcancel\x1aAFTER',
    '\u009d0;cancel\x1b[32mAFTER', '\u0090$qcancel\u009b32mAFTER',
  ]) {
    const bytes = Buffer.from(sequence);
    for (let split = 1; split < bytes.length; split++) {
      const stream = new TerminalStream({ sessionId: 's', instanceId: 'i' }, 30, 4);
      const restored = new headless.Terminal({ cols: 30, rows: 4, scrollback: 2000, allowProposedApi: true });
      const baseline = new headless.Terminal({ cols: 30, rows: 4, allowProposedApi: true });
      const notices: string[][] = [[], []];
      restored.parser.registerOscHandler(0, value => { notices[0].push(value); return true; });
      baseline.parser.registerOscHandler(0, value => { notices[1].push(value); return true; });
      try {
        await write(baseline, bytes);
        await stream.write(bytes.subarray(0, split));
        const seq = await applyFrames(restored, stream, 0);
        await stream.write(bytes.subarray(split));
        await applyFrames(restored, stream, seq);
        assert.deepEqual(allOutput(stream), bytes, `raw bytes at ${split}: ${JSON.stringify(sequence)}`);
        assert.deepEqual(screen(stream.terminal), screen(baseline), `live at ${split}: ${JSON.stringify(sequence)}`);
        assert.deepEqual(screen(restored), screen(baseline), `restore at ${split}: ${JSON.stringify(sequence)}`);
        // Replay re-parses the original bytes, so title side effects are reproduced too.
        assert.deepEqual(notices[0], notices[1], `title at ${split}: ${JSON.stringify(sequence)}`);
      } finally { stream.dispose(); restored.dispose(); baseline.dispose(); }
    }
  }
});
