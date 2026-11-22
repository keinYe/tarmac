import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePsLine, parseProcStat, providerFromProcess, codexProfile, selectForeground, parseCommandLine, parseLsofCwd, foreground } from './process.ts';
import type { ProcessEntry } from './process.ts';

function entry(pid: number, ppid: number, pgid: number, tpgid: number, command: string, extra: Partial<ProcessEntry> = {}): ProcessEntry {
  return { pid, ppid, pgid, tpgid, command, state: 'S', ...extra };
}

test('Linux stat parser accepts parentheses in command and reads terminal group correctly', () => {
  assert.deepEqual(parseProcStat('41 (name (with) spaces)) S 20 41 20 34816 42 0 1 2 3'), {
    pid: 41, ppid: 20, pgid: 41, tpgid: 42, command: 'name (with) spaces)', state: 'S',
  });
  for (const text of ['', 'x (node) S 2 3 4 5 6', '3 (node) S x y z']) assert.equal(parseProcStat(text), undefined);
});

test('Linux and macOS ps fixtures preserve command paths and negative tpgid', () => {
  assert.deepEqual(parsePsLine(' 12 1 12 -1 Ss /usr/bin/zsh'), entry(12, 1, 12, -1, '/usr/bin/zsh', { state: 'Ss' }));
  assert.deepEqual(parsePsLine(' 22 12 22 22 S+ /Applications/CLI Tools/codex'), entry(22, 12, 22, 22, '/Applications/CLI Tools/codex', { state: 'S+' }));
  assert.equal(parsePsLine('PID PPID PGID TPGID STATE COMMAND'), undefined);
});

test('classification recognizes native agents and exact Node entry scripts, not arbitrary arguments', () => {
  assert.equal(providerFromProcess({ command: '/opt/bin/claude' }), 'claude');
  assert.equal(providerFromProcess({ command: '/opt/bin/codex' }), 'codex');
  assert.equal(providerFromProcess({ command: 'node', argv: ['node', '--require', '/preload.js', '/opt/node_modules/@openai/codex/bin/codex.js', '--profile', 'work'] }), 'codex');
  assert.equal(providerFromProcess({ command: 'node', argv: ['node', '/opt/node_modules/@anthropic-ai/claude-code/cli.js'] }), 'claude');
  assert.equal(providerFromProcess({ command: 'MainThread', argv: ['/opt/node', '/opt/@openai/codex/bin/codex.js'] }), 'codex');
  assert.equal(providerFromProcess({ command: 'MainThread', argv: ['/opt/python', '/opt/@openai/codex/bin/codex.js'] }), undefined);
  for (const argv of [
    ['node', '-e', 'require("@openai/codex")'],
    ['node', 'unrelated.js', '/opt/node_modules/@openai/codex/bin/codex.js'],
    ['node', '--eval=codex'],
  ]) assert.equal(providerFromProcess({ command: 'node', argv }), undefined);
  assert.equal(providerFromProcess({ command: 'bash', argv: ['bash', '-c', 'codex'] }), undefined);
});

test('foreground agent wins over its native tool and nested agent, background agent is ignored', () => {
  const shell = entry(10, 1, 10, 20, 'zsh');
  const main = entry(20, 10, 20, 20, 'claude');
  const tool = entry(30, 20, 20, 20, 'bash');
  const nested = entry(40, 30, 20, 20, 'codex');
  const background = entry(50, 10, 50, 20, 'codex');
  assert.equal(selectForeground(10, [shell, nested, tool, background, main])?.pid, 20);
  assert.equal(selectForeground(10, [shell, background, main])?.pid, 20);
});

test('Kimi native, Node and legacy Python entry points and native agy are recognized precisely', () => {
  for (const command of ['/opt/bin/kimi', 'kimi-cli', 'kimi-code']) assert.equal(providerFromProcess({ command }), 'kimi');
  assert.equal(providerFromProcess({ command: '/opt/bin/agy' }), 'agy');
  assert.equal(providerFromProcess({ command: 'node', argv: ['node', '/opt/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'] }), 'kimi');
  assert.equal(providerFromProcess({ command: 'MainThread', argv: ['/opt/bin/node', '/opt/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'] }), 'kimi');
  for (const argv of [['python3', '/venv/bin/kimi'], ['python3', '-u', '-m', 'kimi_cli'],
    ['python3', '-m', 'kimi_cli.__main__'], ['python3', '/venv/lib/kimi_cli/__main__.py']]) {
    assert.equal(providerFromProcess({ command: 'python3.12', argv }), 'kimi');
  }
  for (const argv of [['python3', '-c', '/venv/bin/kimi'], ['python3', 'other.py', '/venv/bin/kimi'],
    ['python3', '-m', 'unrelated', 'kimi_cli']]) assert.equal(providerFromProcess({ command: 'python3', argv }), undefined);
  assert.equal(providerFromProcess({ command: 'node', argv: ['node', 'other.js', '/opt/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'] }), undefined);
  assert.equal(providerFromProcess({ command: 'sh', argv: ['sh', '-c', 'agy'] }), undefined);
});

test('Kimi truncated native process titles require the actual executable identity', () => {
  const native = { command: 'kimi-cod', argv: ['kimi-cod'], executable: '/home/user/.kimi-code/bin/kimi' };
  assert.equal(providerFromProcess(native), 'kimi');
  assert.equal(providerFromProcess({ ...native, executable: '/usr/bin/node' }), undefined);
  assert.equal(providerFromProcess({ command: 'kimi-cod', argv: ['kimi-cod'] }), undefined);
  const processes = [entry(10, 1, 10, 20, 'zsh'), entry(20, 10, 20, 20, 'kimi-cod', { executable: native.executable }),
    entry(30, 20, 20, 20, 'codex')];
  assert.equal(selectForeground(10, processes)?.pid, 20, 'nested tools must not replace the native owner');
});

test('Codex profile recognition follows aliases and CLI flags without reading configuration contents', () => {
  for (const argv of [['codex', '-p', 'deepseek'], ['codex', '--profile=deepseek'], ['codex', '-pdeepseek']]) {
    assert.equal(codexProfile({ command: '/opt/bin/codex', argv }), 'deepseek');
  }
  assert.equal(codexProfile({ command: 'codex', argv: ['codex', 'resume', 'session-id', '--profile', 'ark'] }), 'ark');
  assert.equal(codexProfile({ command: 'codex', argv: ['codex', '-p', 'ark', '--profile=custom'] }), 'custom');
  assert.equal(codexProfile({ command: 'node', argv: ['node', '/opt/@openai/codex/bin/codex.js', '-p', 'ark'] }), 'ark');
  assert.equal(codexProfile({ command: 'codex-ds' }), 'deepseek');
  assert.equal(codexProfile({ command: 'codex-ark' }), 'ark');
  assert.equal(providerFromProcess({ command: 'codex-ds' }), 'codex');
  assert.equal(codexProfile({ command: 'codex', argv: ['codex', '--', '-p', 'ignored'] }), undefined);
  assert.equal(codexProfile({ command: 'codex', argv: ['codex', '-m', '-park'] }), undefined);
  assert.equal(codexProfile({ command: 'codex', argv: ['codex', '--profile'] }), undefined);
  assert.equal(codexProfile({ command: 'kimi', argv: ['kimi', '-p', 'a prompt'] }), undefined);
});

test('Kimi and Antigravity remain the foreground owner while their tools launch another agent', () => {
  for (const provider of ['kimi', 'agy']) {
    const processes = [entry(10, 1, 10, 20, 'zsh'), entry(20, 10, 20, 20, provider),
      entry(30, 20, 20, 20, 'bash'), entry(40, 30, 20, 20, 'codex')];
    assert.equal(selectForeground(10, processes)?.pid, 20);
    assert.equal(providerFromProcess(selectForeground(10, processes)!), provider);
  }
});

test('an agent remains associated when it gives the terminal foreground to a tool process group', () => {
  const processes = [entry(10, 1, 10, 30, 'zsh'), entry(20, 10, 20, 30, 'claude'), entry(30, 20, 30, 30, 'bash')];
  assert.equal(selectForeground(10, processes)?.pid, 20);
});

test('agent exit returns to Shell and a later foreground agent replaces it', () => {
  const shell = entry(10, 1, 10, 10, 'zsh');
  const background = entry(50, 10, 50, 10, 'claude');
  assert.equal(selectForeground(10, [shell, background])?.pid, 10);
  assert.equal(selectForeground(10, [{ ...shell, tpgid: 60 }, background, entry(60, 10, 60, 60, 'codex')])?.pid, 60);
  assert.equal(selectForeground(10, [{ ...shell, tpgid: 60 }, background, entry(60, 10, 60, 60, 'codex', { state: 'Z' })]), undefined);
});

test('direct agents, Node wrappers and foreground pipelines use conservative ownership', () => {
  assert.equal(selectForeground(20, [entry(20, 1, 20, 20, 'codex')])?.pid, 20);
  const wrapper = entry(20, 10, 20, 20, 'node', { argv: ['node', '/opt/@openai/codex/bin/codex.js'] });
  assert.equal(selectForeground(10, [entry(10, 1, 10, 20, 'zsh'), wrapper, entry(21, 20, 20, 20, 'codex')])?.pid, 21);
  const pipeline = [entry(10, 1, 10, 19, 'zsh'), entry(19, 10, 19, 19, 'bash'), entry(20, 19, 19, 19, 'codex'), entry(21, 19, 19, 19, 'claude')];
  assert.equal(providerFromProcess(selectForeground(10, pipeline)!), undefined);
  assert.equal(selectForeground(10, pipeline)?.pid, 19);
  assert.equal(selectForeground(10, [entry(10, 1, 10, -1, 'zsh')]), undefined);
});

test('Codex launcher unwraps only a unique direct native child, never nested agents or tools', () => {
  const shell = entry(10, 1, 10, 20, 'zsh');
  const wrapper = entry(20, 10, 20, 20, 'node', { argv: ['node', '/opt/@openai/codex/bin/codex.js'] });
  const native = entry(21, 20, 20, 20, '/opt/bin/codex');
  assert.equal(selectForeground(10, [shell, wrapper])?.pid, 20);
  assert.equal(selectForeground(10, [shell, wrapper, native, entry(22, 21, 20, 20, 'codex')])?.pid, 21);
  assert.equal(selectForeground(10, [shell, wrapper, native, entry(22, 20, 20, 20, 'codex')])?.pid, 20);
  assert.equal(selectForeground(10, [shell, wrapper, entry(21, 20, 20, 20, 'bash'), entry(22, 21, 20, 20, 'codex')])?.pid, 20);
});

test('macOS command and lsof parsers handle quoted paths and reject partial records', () => {
  assert.deepEqual(parseCommandLine('node "/Applications/CLI Tools/@openai/codex/bin/codex.js"'), ['node', '/Applications/CLI Tools/@openai/codex/bin/codex.js']);
  assert.deepEqual(parseCommandLine('node "unfinished'), []);
  assert.equal(parseLsofCwd('p20\nfcwd\nn/Users/dev/my project\n'), '/Users/dev/my project');
  assert.equal(parseLsofCwd('p20\nfcwd\nnrelative'), undefined);
});

test('missing or non-terminal process never creates a guessed foreground agent', async () => {
  assert.equal(await foreground(-1, process.cwd()), undefined);
  assert.equal(await foreground(999999999, process.cwd()), undefined);
});
