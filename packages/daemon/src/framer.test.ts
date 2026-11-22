import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalFramer } from './framer.ts';

test('holds UTF-8 and control sequences across reconnect boundaries without changing bytes', () => {
  const stream = Buffer.from('中文\x1b[31mred\x1b[0m\x1b]0;title\x07\x1bP$qm\x1b\\end');
  const framer = new TerminalFramer();
  const complete: Buffer[] = [];
  for (const byte of stream) complete.push(framer.push(Buffer.of(byte)));
  assert.deepEqual(Buffer.concat(complete), stream);
  assert.equal(framer.pendingBytes, 0);
});

test('only publishes ground-state prefixes and preserves an unfinished suffix', () => {
  const framer = new TerminalFramer();
  assert.equal(framer.push(Buffer.from('abc\x1b[31')).toString(), 'abc');
  assert.equal(framer.push(Buffer.from('m中文')).toString(), '\x1b[31m中文');
  assert.equal(framer.push(Buffer.from('\x1b]52;c;secret')).length, 0);
  assert.equal(framer.push(Buffer.from('\x1b\\')).toString(), '\x1b]52;c;secret\x1b\\');
});

test('oversized incomplete sequences fail visibly instead of dropping a suffix', () => {
  const framer = new TerminalFramer();
  assert.throws(() => framer.push(Buffer.from('\x1b]' + 'x'.repeat(1024 * 1024))), /exceeds/);
});

test('UTF-8 C1 introducers remain pending until their complete terminator', () => {
  for (const [prefix, suffix] of [
    ['\u009b31', 'm'],
    ['\u009d0;title', '\u009c'],
    ['\u0090$qpayload', '\u009c'],
    ['\u0098ignored', '\u009c'],
    ['\u009eignored', '\u009c'],
    ['\u009fignored', '\u009c'],
  ]) {
    const framer = new TerminalFramer();
    const pieces: Buffer[] = [];
    for (const byte of Buffer.from(prefix)) pieces.push(framer.push(Buffer.of(byte)));
    assert.equal(Buffer.concat(pieces).length, 0, JSON.stringify(prefix));
    assert.equal(framer.pendingBytes, Buffer.byteLength(prefix));
    for (const byte of Buffer.from(suffix)) pieces.push(framer.push(Buffer.of(byte)));
    assert.deepEqual(Buffer.concat(pieces), Buffer.from(prefix + suffix));
    assert.equal(framer.pendingBytes, 0);
  }
});

test('C0 cancellation and C1 replacement release only complete control boundaries', () => {
  for (const prefix of ['\x1b[31', '\u009b31', '\x1b]0;title', '\u009d0;title', '\x1bP$qdata', '\u0090$qdata']) {
    for (const suffix of ['\x18AFTER', '\x1aAFTER', '\u009cAFTER', '\u0085AFTER', '\x1b[32mAFTER', '\u009b32mAFTER']) {
      const framer = new TerminalFramer();
      assert.equal(framer.push(Buffer.from(prefix)).length, 0);
      assert.deepEqual(framer.push(Buffer.from(suffix)), Buffer.from(prefix + suffix));
      assert.equal(framer.pendingBytes, 0);
    }
  }
});

test('C0 inside strings is retained and invalid UTF-8 never becomes a C1 control', () => {
  const framer = new TerminalFramer();
  assert.equal(framer.push(Buffer.from('\u0090$qdata\n\x07')).length, 0);
  const close = Buffer.concat([Buffer.from('\u0090$qdata\n\x07'), Buffer.from('\u009c')]);
  assert.deepEqual(framer.push(Buffer.from('\u009c')), close);
  const invalid = Buffer.from([0xe0, 0x82, 0x9b]); // Overlong U+009B is not CSI.
  assert.deepEqual(framer.push(invalid), invalid);
  assert.equal(framer.pendingBytes, 0);
});

test('C0 embedded in ESC/CSI and ESC intermediates does not create a false boundary', () => {
  const framer = new TerminalFramer();
  assert.equal(framer.push(Buffer.from('\x1b(\x00')).length, 0);
  assert.deepEqual(framer.push(Buffer.from('B')), Buffer.from('\x1b(\x00B'));
  assert.equal(framer.push(Buffer.from('\x1b[3\x00')).length, 0);
  assert.deepEqual(framer.push(Buffer.from('1m')), Buffer.from('\x1b[3\x001m'));
});
