import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { suppressTerminalQueries } from './query-guard.ts';

function write(term: InstanceType<typeof headless.Terminal>, data: string): Promise<void> {
  return new Promise(resolve => term.write(data, resolve));
}

test('frontend parser emits no query replies but preserves terminal state and user input', async () => {
  const baseline = new headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const frontend = new headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const replies: string[] = [];
  const baselineReplies: string[] = [];
  const guard = suppressTerminalQueries(frontend.parser);
  frontend.onData(data => replies.push(data));
  baseline.onData(data => baselineReplies.push(data));
  const data = 'hello\x1b[31m中\x1b[0m\r\n'
    + '\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[4$p\x1b[?7$p\x1bP$qm\x1b\\'
    + '\x1b[?2004h\x1b[?1h\x1b[2;3Hworld';
  await Promise.all([write(baseline, data), write(frontend, data)]);
  assert.ok(baselineReplies.length >= 7, 'baseline actually exercises automatic reply paths');
  assert.deepEqual(replies, []);
  assert.deepEqual(frontend.modes, baseline.modes);
  assert.equal(frontend.buffer.active.cursorX, baseline.buffer.active.cursorX);
  assert.equal(frontend.buffer.active.cursorY, baseline.buffer.active.cursorY);
  for (let row = 0; row < frontend.rows; row++) {
    assert.equal(frontend.buffer.active.getLine(row)?.translateToString(), baseline.buffer.active.getLine(row)?.translateToString());
  }
  frontend.input('用户输入\r', true);
  assert.deepEqual(replies, ['用户输入\r']);
  guard.dispose();
  await write(frontend, '\x1b[6n');
  assert.equal(replies.length, 2, 'disposing guard restores the original parser behavior');
  frontend.dispose();
  baseline.dispose();
});

test('mixed OSC color operations reach native parsing while synchronous replies stay local', async () => {
  const term = new headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const reachedDefault: { id: number; data: string }[] = [];
  const emitted: string[] = [];
  const forwarded: string[] = [];
  const decisions: boolean[] = [];
  // The headless terminal has no browser ThemeService. A lower-priority public
  // hook models only its synchronous response delivery, then delegates to the
  // native color parser. The guard must not consume the mixed SET/QUERY payload.
  const observers = [4, 10, 11, 12].map(id => term.parser.registerOscHandler(id, data => {
    reachedDefault.push({ id, data });
    decisions.push(guard.shouldForwardData());
    if (data.split(';').includes('?')) term.input(`\x1b]${id};rgb:0000/0000/0000\x1b\\`);
    return false;
  }));
  const guard = suppressTerminalQueries(term.parser);
  term.onData(data => { emitted.push(data); if (guard.shouldForwardData()) forwarded.push(data); });
  const operations = [
    { id: 4, data: '1;#112233;2;?' },
    { id: 10, data: '#445566;?' },
    { id: 11, data: '?;#778899' },
    { id: 12, data: '?' },
  ];
  await write(term, operations.map(({ id, data }) => `\x1b]${id};${data}\x07`).join('') + 'still-rendered');
  assert.deepEqual(reachedDefault, operations);
  assert.deepEqual(decisions, [false, false, false, false]);
  assert.equal(emitted.length, 4, 'the synchronous reply path actually ran');
  assert.deepEqual(forwarded, [], 'automatic replies never reach the PTY');
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'still-rendered');
  assert.equal(guard.shouldForwardData(), true, 'the microtask has released the input gate');
  term.input('拼音提交中\r', true);
  assert.deepEqual(forwarded, ['拼音提交中\r']);
  guard.dispose();
  observers.forEach(observer => observer.dispose());
  term.dispose();
});

test('color SET without a query never gates input, and a query gate ends at the microtask boundary', async () => {
  const term = new headless.Terminal({ allowProposedApi: true });
  const decisions: boolean[] = [];
  const forwarded: string[] = [];
  const observer = term.parser.registerOscHandler(10, data => {
    decisions.push(guard.shouldForwardData());
    if (data === '?') {
      term.input('automatic-reply');
      queueMicrotask(() => term.input('next-microtask-user-input', true));
    }
    return false;
  });
  const guard = suppressTerminalQueries(term.parser);
  term.onData(data => { if (guard.shouldForwardData()) forwarded.push(data); });
  await write(term, '\x1b]10;#112233\x07');
  assert.deepEqual(decisions, [true]);
  await write(term, '\x1b]10;?\x07');
  assert.deepEqual(decisions, [true, false]);
  assert.deepEqual(forwarded, ['next-microtask-user-input']);
  guard.dispose();
  observer.dispose();
  term.dispose();
});
