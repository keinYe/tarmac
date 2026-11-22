import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { TerminalStream } from './terminal.ts';
import { restore, write } from '../test/restore.ts';

type Terminal = InstanceType<typeof headless.Terminal>;

// Deliberately uses only the public terminal/buffer/cell API. Future input checks
// expose state that a framebuffer-only equality check cannot observe directly.
function fingerprint(terminal: Terminal): unknown {
  const buffer = terminal.buffer.active;
  return {
    cols: terminal.cols, rows: terminal.rows, modes: terminal.modes,
    type: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY,
    lines: Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row)!;
      return {
        wrapped: line.isWrapped,
        cells: Array.from({ length: line.length }, (_, column) => {
          const cell = line.getCell(column)!;
          return [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
            cell.getBgColorMode(), cell.getBgColor(), Boolean(cell.isBold()), Boolean(cell.isItalic()),
            Boolean(cell.isUnderline()), Boolean(cell.isInverse())];
        }),
      };
    }),
  };
}

async function checkContinuation(prefix: string, suffix: string): Promise<void> {
  const stream = new TerminalStream({ sessionId: 'state-test', instanceId: 'run' }, 40, 12);
  let mirror: Terminal | undefined;
  try {
    await stream.write(Buffer.from(prefix));
    ({ terminal: mirror } = await restore(stream));
    assert.deepEqual(fingerprint(mirror), fingerprint(stream.terminal), 'state immediately after replay restoration');
    await stream.write(Buffer.from(suffix));
    await write(mirror, Buffer.from(suffix));
    assert.deepEqual(fingerprint(mirror), fingerprint(stream.terminal), 'state after continuing the original byte stream');
  } finally { stream.dispose(); mirror?.dispose(); }
}

test('restored scroll margins keep subsequent line feeds inside the original region', async () => {
  await checkContinuation('one\r\ntwo\r\nthree\r\nfour\x1b[2;3r\x1b[3;1H', '\nNEW');
});

test('restored origin mode preserves the actual cursor and margins before continuing output', async () => {
  await checkContinuation('\x1b[3;8r\x1b[?6h\x1b[2;2Hcontent', '\x1b[6;1H\nNEXT');
});

test('restored custom tab stops preserve later horizontal tab movement', async () => {
  await checkContinuation('\x1b[3g\x1b[1;5H\x1bH\x1b[1;1H', '\tX');
});

test('restored DEC saved cursor restores position and attributes on ESC 8', async () => {
  await checkContinuation('\x1b[2;3H\x1b[31m\x1b7\x1b[0m\x1b[4;8H', '\x1b8X');
});

test('restored SCO saved cursor preserves a later CSI u', async () => {
  await checkContinuation('\x1b[2;3H\x1b[s\x1b[4;8H', '\x1b[uX');
});

test('restored G0 DEC special graphics designation still translates following bytes', async () => {
  await checkContinuation('\x1b(0lqk', 'q');
});

test('restored G1 designation and shift-out preserve subsequent special graphics', async () => {
  await checkContinuation('\x1b)0\x0elqk', 'q\x0fASCII');
});
