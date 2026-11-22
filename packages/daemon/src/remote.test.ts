import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { keyBytes, pasteBytes, screenText } from './remote.ts';

// A real headless emulator, as the daemon uses; nothing else is started.
async function terminal(cols: number, rows: number, data: string) {
  const term = new headless.Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(data, resolve));
  return term;
}

test('normal buffer returns N scrollback rows plus the whole viewport, without control sequences', async () => {
  // 12 lines in 5 rows: line-7..line-11 are visible, line-0..line-6 are scrollback.
  const lines = Array.from({ length: 12 }, (_, i) => `\x1b[31mline-${i}\x1b[0m   `).join('\r\n');
  const term = await terminal(20, 5, lines);
  assert.deepEqual(screenText(term, 3, true), { text: 'line-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10\nline-11', alternate: false });
  assert.equal(screenText(term, 2000, true).text.split('\n').length, 12, 'N beyond the scrollback stops at its start');
  assert.doesNotMatch(screenText(term, 30, true).text, /\x1b/);
  // A fresh session writes at the top: the blank viewport bottom never hides it (capture-pane -S -1).
  const fresh = await terminal(20, 6, 'READY');
  assert.deepEqual(screenText(fresh, 1, true).text.split('\n'), ['READY', '', '', '', '', '']);
});

test('soft-wrapped rows are joined by default and kept as screen rows with --no-join', async () => {
  // 25 characters in a 10-column terminal wrap onto three rows; the trailing spaces before the
  // wrap point belong to the logical line and survive the join.
  const term = await terminal(10, 6, 'abcd      efghijklmnopqrstu\r\nnext');
  const joined = screenText(term, 6, true).text.split('\n');
  assert.equal(joined[0], 'abcd      efghijklmnopqrstu');
  assert.equal(joined[1], 'next');
  const rows = screenText(term, 6, false).text.split('\n');
  assert.deepEqual(rows.slice(0, 4), ['abcd', 'efghijklmn', 'opqrstu', 'next']);
});

test('alternate screen returns the viewport only and ignores N', async () => {
  const before = Array.from({ length: 20 }, (_, i) => `shell-${i}`).join('\r\n');
  const term = await terminal(20, 4, `${before}\x1b[?1049h\x1b[H\x1b[2Jmenu\r\n› 1. Yes\r\n  2. No`);
  const screen = screenText(term, 2000, false);
  assert.equal(screen.alternate, true);
  assert.deepEqual(screen.text.split('\n'), ['menu', '› 1. Yes', '  2. No', '']);
  assert.doesNotMatch(screen.text, /shell-/);
});

test('bracketed paste wraps text and removes an embedded end marker; plain mode writes it as is', () => {
  assert.equal(pasteBytes('hi\x1b[201~there', true), '\x1b[200~hithere\x1b[201~');
  assert.equal(pasteBytes('多行\n文本', false), '多行\n文本');
});

test('cursor keys follow DECCKM; Enter is CR and Escape is ESC', () => {
  assert.equal(keyBytes(['Up', 'Down', 'Enter'], false), '\x1b[A\x1b[B\r');
  assert.equal(keyBytes(['Up', 'Down', 'Escape'], true), '\x1bOA\x1bOB\x1b');
});
