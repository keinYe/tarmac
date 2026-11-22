import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { helperPath, normalizeDetails, normalizeSnapshot, programName } from './winproc.ts';
import { providerFromProcess, selectForegroundWindows } from './process.ts';
import type { ProcessEntry } from './process.ts';

test('Windows snapshot names are lower-case stems and invalid rows are dropped', () => {
  const entries = normalizeSnapshot([
    { pid: 10, ppid: 4, name: 'PWSH.EXE', startedAt: 100 },
    { pid: 11, ppid: 10, name: 'Claude.exe', startedAt: 200 },
    { pid: 0, ppid: 0, name: 'System Idle Process' },
    { pid: 12, ppid: 10, name: '' },
    null,
  ]);
  assert.deepEqual(entries.map(entry => [entry.pid, entry.command]), [[10, 'pwsh'], [11, 'claude']]);
  assert.equal(providerFromProcess(entries[1]), 'claude');
  assert.throws(() => normalizeSnapshot({}), /invalid process snapshot/);
});

test('a reused or missing Windows parent PID is not a parent link', () => {
  const entries = normalizeSnapshot([
    { pid: 10, ppid: 1, name: 'pwsh.exe', startedAt: 500 },
    { pid: 20, ppid: 10, name: 'node.exe', startedAt: 400 },  // its parent 10 died; 10 was reused
    { pid: 30, ppid: 10, name: 'node.exe', startedAt: 600 },
    { pid: 40, ppid: 99, name: 'cmd.exe', startedAt: 700 },   // parent gone
    { pid: 50, ppid: 10, name: 'git.exe' },                   // start time unreadable
  ]);
  const ppid = new Map(entries.map(entry => [entry.pid, entry.ppid]));
  assert.equal(ppid.get(20), 0);
  assert.equal(ppid.get(30), 10);
  assert.equal(ppid.get(40), 0);
  assert.equal(ppid.get(50), 0);
});

test('Windows process details keep only absolute paths and string argv', () => {
  const details = normalizeDetails([
    { pid: 7, argv: ['node', 'C:\\npm\\cli.js'], cwd: 'C:\\work\\repo\\', executable: 'C:\\Program Files\\nodejs\\node.exe' },
    { pid: 8, argv: [1], cwd: 'relative', executable: 'node.exe' },
    { pid: 9, cwd: 'C:\\' },
    { pid: -1 },
  ]);
  assert.deepEqual(details, [
    { pid: 7, argv: ['node', 'C:\\npm\\cli.js'], cwd: 'C:\\work\\repo', executable: 'C:\\Program Files\\nodejs\\node.exe' },
    { pid: 8 },
    { pid: 9, cwd: 'C:\\' },
  ]);
});

test('the helper is found next to the bundled daemon unless overridden', () => {
  assert.equal(helperPath({}, '/pkg/resources/app/dist/daemon.cjs'), path.join('/pkg/resources/app/dist', 'native', 'tarmac-native.exe'));
  assert.equal(helperPath({ TARMAC_NATIVE: 'C:\\x\\h.exe' }, '/ignored'), 'C:\\x\\h.exe');
  assert.equal(programName('C:\\Users\\me\\.local\\bin\\Kimi.EXE'), 'kimi');
});

function win(pid: number, ppid: number, command: string, extra: Partial<ProcessEntry> = {}): ProcessEntry {
  return { pid, ppid, pgid: 0, tpgid: 0, state: 'R', command, ...extra };
}

test('Windows foreground: an npm agent behind cmd is selected, its tools are not', () => {
  const tree = [
    win(10, 1, 'pwsh'),
    win(11, 10, 'cmd'),
    win(12, 11, 'node', { argv: ['node', 'C:/Users/me/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js'] }),
    win(13, 12, 'bash'),
    win(14, 13, 'codex'),
    win(15, 1, 'claude'),  // outside this PTY
  ];
  assert.equal(selectForegroundWindows(10, tree)?.pid, 12);
});

test('Windows foreground unwraps the npm Codex launcher to its native child', () => {
  const tree = [
    win(10, 1, 'pwsh'),
    win(12, 10, 'node', { argv: ['node', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] }),
    win(13, 12, 'codex'),
  ];
  assert.equal(selectForegroundWindows(10, tree)?.pid, 13);
});

test('Windows foreground without an agent follows a single chain and stops at branches', () => {
  assert.equal(selectForegroundWindows(10, [win(10, 1, 'pwsh')])?.pid, 10);
  assert.equal(selectForegroundWindows(10, [win(10, 1, 'pwsh'), win(11, 10, 'npm'), win(12, 11, 'node'), win(13, 10, 'conhost')])?.pid, 12,
    'console hosts are not programs');
  assert.equal(selectForegroundWindows(10, [win(10, 1, 'pwsh'), win(11, 10, 'vim'), win(12, 10, 'git')])?.pid, 10);
  assert.equal(selectForegroundWindows(10, [win(11, 10, 'vim')]), undefined, 'the PTY root must be present');
});

test('Windows sibling agents have no unique owner and report the shell', () => {
  assert.equal(selectForegroundWindows(10, [win(10, 1, 'pwsh'), win(11, 10, 'claude'), win(12, 10, 'codex')])?.pid, 10);
});
