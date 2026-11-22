import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { inspectHookConfig } from './inspect.ts';
import type { InspectOptions } from './inspect.ts';
import { HOOK_MARKER } from './config.ts';

const owned = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /app/cli.cjs hook claude' + HOOK_MARKER }] }] } };
async function fixture() {
  const root = path.resolve('.tmp/app-m0-validation');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'inspect-'));
  const homeDir = path.join(directory, 'home'); const cwd = path.join(directory, 'project');
  await Promise.all([mkdir(homeDir), mkdir(cwd)]);
  const options: InspectOptions = { env: {}, homeDir, cwd };
  const put = async (filename: string, value: unknown) => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, JSON.stringify(value));
    return filename;
  };
  return { directory, homeDir, cwd, options, put, cleanup: () => rm(directory, { recursive: true }) };
}

test('missing configuration reports false with the exact JSON inspection scope', async () => {
  const f = await fixture();
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const result = await inspectHookConfig(provider, f.options);
      assert.equal(result.configured, false);
      assert.equal(result.error, undefined);
      assert.match(result.source!, /not inspected/);
      assert.ok(result.source!.includes(path.join(f.homeDir, provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json')));
    }
  } finally { await f.cleanup(); }
});

test('Claude user hook is identified without changing any configuration bytes', async () => {
  const f = await fixture();
  try {
    const filename = await f.put(path.join(f.homeDir, '.claude/settings.json'), { ...owned, token: 'do-not-report' });
    const before = await readFile(filename, 'utf8');
    const result = await inspectHookConfig('claude', f.options);
    assert.equal(result.configured, true);
    assert.equal(await readFile(filename, 'utf8'), before);
    assert.equal(JSON.stringify(result).includes('do-not-report'), false);
  } finally { await f.cleanup(); }
});

test('CLAUDE_CONFIG_DIR and CODEX_HOME override the default home paths', async () => {
  const f = await fixture();
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const override = path.join(f.directory, provider);
      const filename = await f.put(path.join(override, provider === 'claude' ? 'settings.json' : 'hooks.json'), owned);
      const result = await inspectHookConfig(provider, { ...f.options, env: { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: override } });
      assert.equal(result.configured, true);
      assert.ok(result.source!.includes(filename));
      assert.equal(result.source!.includes(path.join(f.homeDir, '.' + provider)), false);
    }
  } finally { await f.cleanup(); }
});

test('ordinary hooks, marker substrings and non-command handlers are not owned Tarmac hooks', async () => {
  const f = await fixture();
  try {
    const settings = { hooks: { Stop: [{ hooks: [
      { type: 'command', command: 'tarmac-helper --event Stop' },
      { type: 'command', command: 'echo' + HOOK_MARKER + ' is just text' },
      { type: 'prompt', command: 'node cli.cjs' + HOOK_MARKER },
      { type: 'command', command: 'node cli.cjs' + HOOK_MARKER, enabled: false },
    ] }] } };
    await f.put(path.join(f.homeDir, '.codex/hooks.json'), settings);
    assert.equal((await inspectHookConfig('codex', f.options)).configured, false);
  } finally { await f.cleanup(); }
});

test('explicit Claude settings file merges hooks with lower layers instead of erasing them', async () => {
  const f = await fixture();
  try {
    await f.put(path.join(f.homeDir, '.claude/settings.json'), owned);
    const extra = await f.put(path.join(f.cwd, 'extra.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'another-hook' }] }] }, model: 'anything' });
    const result = await inspectHookConfig('claude', { ...f.options, args: ['--settings', './extra.json'] });
    assert.equal(result.configured, true);
    assert.ok(result.source!.includes(extra));
    await f.put(path.join(f.homeDir, '.claude/settings.json'), {});
    await f.put(extra, owned);
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--settings=./extra.json'] })).configured, true);
  } finally { await f.cleanup(); }
});

test('inline Claude JSON is inspected without exposing its contents in diagnostic source', async () => {
  const f = await fixture();
  try {
    const settings = JSON.stringify({ ...owned, token: 'never-include-inline-content' });
    const result = await inspectHookConfig('claude', { ...f.options, args: ['--settings', settings] });
    assert.equal(result.configured, true);
    assert.match(result.source!, /inline JSON/);
    assert.equal(JSON.stringify(result).includes('never-include-inline-content'), false);
    const invalid = await inspectHookConfig('claude', { ...f.options, args: ['--settings', '{"password":"secret",'] });
    assert.equal(invalid.configured, false);
    assert.match(invalid.error!, /Invalid JSON/);
    assert.equal(JSON.stringify(invalid).includes('password'), false);
  } finally { await f.cleanup(); }
});

test('disableAllHooks follows known JSON precedence and CLI false can restore lower configured hooks', async () => {
  const f = await fixture();
  try {
    await f.put(path.join(f.homeDir, '.claude/settings.json'), owned);
    await f.put(path.join(f.cwd, '.claude/settings.json'), { disableAllHooks: true });
    const disabled = await inspectHookConfig('claude', f.options);
    assert.equal(disabled.configured, false);
    assert.match(disabled.error!, /disableAllHooks/);
    await f.put(path.join(f.cwd, '.claude/settings.local.json'), { disableAllHooks: false });
    assert.equal((await inspectHookConfig('claude', f.options)).configured, true);
    await f.put(path.join(f.cwd, '.claude/settings.local.json'), { disableAllHooks: true });
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--settings', '{"disableAllHooks":false}'] })).configured, true);
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--settings', '{"disableAllHooks":true}'] })).configured, false);
  } finally { await f.cleanup(); }
});

test('setting-sources excludes unselected user hooks but preserves explicit settings', async () => {
  const f = await fixture();
  try {
    await f.put(path.join(f.homeDir, '.claude/settings.json'), owned);
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--setting-sources', 'project,local'] })).configured, false);
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--setting-sources=', '--settings', JSON.stringify(owned)] })).configured, true);
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--setting-sources', 'future'] })).configured, false);
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--settings'] })).configured, false);
  } finally { await f.cleanup(); }
});

test('safe and bare modes do not claim custom hooks are available', async () => {
  const f = await fixture();
  try {
    await f.put(path.join(f.homeDir, '.claude/settings.json'), owned);
    for (const args of [['--safe-mode'], ['--bare']]) {
      const result = await inspectHookConfig('claude', { ...f.options, args });
      assert.equal(result.configured, false);
      assert.ok(result.error);
    }
    for (const env of [{ CLAUDE_CODE_SAFE_MODE: '1' }, { CLAUDE_CODE_SIMPLE: 'true' }]) {
      assert.equal((await inspectHookConfig('claude', { ...f.options, env })).configured, false);
    }
    assert.equal((await inspectHookConfig('claude', { ...f.options, args: ['--', '--safe-mode'] })).configured, true);
  } finally { await f.cleanup(); }
});

test('malformed JSON, hooks and gating keys fail visibly without echoing contents', async () => {
  const f = await fixture();
  const filename = path.join(f.homeDir, '.claude/settings.json');
  try {
    for (const value of [[], { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{ hooks: [null] }] } }, { disableAllHooks: 'false' }, { allowManagedHooksOnly: true }]) {
      await f.put(filename, value);
      const result = await inspectHookConfig('claude', f.options);
      assert.equal(result.configured, false);
      assert.ok(result.error);
    }
    await writeFile(filename, '{"token":"confidential",');
    const result = await inspectHookConfig('claude', f.options);
    assert.equal(result.configured, false);
    assert.equal(JSON.stringify(result).includes('confidential'), false);
  } finally { await f.cleanup(); }
});

test('unreadable and oversized settings report an error rather than claiming hooks are missing', async () => {
  const f = await fixture();
  const filename = await f.put(path.join(f.homeDir, '.codex/hooks.json'), owned);
  try {
    await chmod(filename, 0o000);
    if (process.getuid?.() !== 0) {
      const result = await inspectHookConfig('codex', f.options);
      assert.equal(result.configured, false);
      assert.match(result.error!, /EACCES/);
    }
    await chmod(filename, 0o600);
    await writeFile(filename, ' '.repeat(2 * 1024 * 1024 + 1));
    const result = await inspectHookConfig('codex', f.options);
    assert.equal(result.configured, false);
    assert.match(result.error!, /2 MiB/);
    const missingExplicit = await inspectHookConfig('claude', { ...f.options, args: ['--settings', 'does-not-exist.json'] });
    assert.match(missingExplicit.error!, /ENOENT/);
  } finally { await chmod(filename, 0o600).catch(() => {}); await f.cleanup(); }
});

test('Codex inspection never treats inline TOML or a plugin as a checked JSON source', async () => {
  const f = await fixture();
  try {
    await f.put(path.join(f.homeDir, '.codex/config.toml'), owned);
    const absent = await inspectHookConfig('codex', f.options);
    assert.equal(absent.configured, false);
    assert.match(absent.source!, /TOML.*not inspected/);
    assert.equal(absent.source!.includes('config.toml'), false);
    await f.put(path.join(f.homeDir, '.codex/hooks.json'), owned);
    const found = await inspectHookConfig('codex', f.options);
    assert.equal(found.configured, true);
    assert.match(found.source!, /trust.*not inspected/);
  } finally { await f.cleanup(); }
});
