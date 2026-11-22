import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HookInstaller, configDirectory } from './hooks.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');

async function setup(command: string | null = '/app/cli') {
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, 'hooks-'));
  const installer = new HookInstaller({ homeDir: home, env: {}, backupDir: path.join(home, 'backups'),
    ...(command ? { command: provider => `${command} hook ${provider}` } : {}), unavailable: 'dev build' });
  return { home, installer, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('Kimi: missing, install with backup, current, exact undo', async () => {
  const t = await setup();
  try {
    const target = path.join(t.home, '.kimi-code', 'config.toml');
    await assert.rejects(t.installer.apply(), /请先查看安装方案/);
    assert.equal((await t.installer.status('kimi')).state, 'unavailable', 'Kimi without a config is not offered');
    await mkdir(path.dirname(target));
    const original = 'default_model = "k3"\n';
    await writeFile(target, original);
    assert.deepEqual(await t.installer.status('kimi'), { state: 'missing' });
    const plan = await t.installer.preview('kimi');
    assert.equal(plan.target, target);
    assert.equal(plan.adds.length, 12);
    assert.deepEqual(plan.removes, []);
    const applied = await t.installer.apply();
    assert.equal(await readFile(applied.backup!, 'utf8'), original);
    assert.deepEqual(await t.installer.status('kimi'), { state: 'current' });
    await t.installer.undo();
    assert.equal(await readFile(target, 'utf8'), original);
    await assert.rejects(t.installer.undo(), /没有可撤销/);
  } finally { await t.cleanup(); }
});

test('a moved App is reported stale and repaired in place', async () => {
  const old = await setup('/old/cli');
  try {
    await mkdir(path.join(old.home, '.claude'));
    await old.installer.preview('claude');
    await old.installer.apply();
    const moved = new HookInstaller({ homeDir: old.home, env: {}, backupDir: path.join(old.home, 'backups'), command: provider => `/new/cli hook ${provider}` });
    assert.deepEqual(await moved.status('claude'), { state: 'stale' });
    const plan = await moved.preview('claude');
    assert.ok(plan.removes.every(item => item.command === '/old/cli hook claude # tarmac-app') && plan.removes.length === 10);
    await moved.apply();
    assert.deepEqual(await moved.status('claude'), { state: 'current' });
    assert.doesNotMatch(await readFile(path.join(old.home, '.claude', 'settings.json'), 'utf8'), /\/old\/cli/);
  } finally { await old.cleanup(); }
});

test('Claude: a created settings file is removed on undo; later edits block undo', async () => {
  const t = await setup();
  try {
    const target = path.join(t.home, '.claude', 'settings.json');
    await t.installer.preview('claude');
    const applied = await t.installer.apply();
    assert.equal(applied.backup, undefined);
    await t.installer.undo();
    await assert.rejects(readFile(target), { code: 'ENOENT' });

    await writeFile(target, '{"model":"opus"}\n');
    await t.installer.preview('claude');
    await t.installer.apply();
    await writeFile(target, (await readFile(target, 'utf8')) + ' ');
    await assert.rejects(t.installer.undo(), /又被修改过/);
    assert.equal((await readdir(path.join(t.home, 'backups'))).length, 1);
  } finally { await t.cleanup(); }
});

test('without a stable command nothing is read or offered', async () => {
  const t = await setup(null);
  try {
    assert.deepEqual(await t.installer.status('claude'), { state: 'unavailable', reason: 'dev build' });
    await assert.rejects(t.installer.preview('kimi'), /dev build/);
  } finally { await t.cleanup(); }
  assert.equal(configDirectory('claude', { CLAUDE_CONFIG_DIR: '/c' }, '/h'), path.resolve('/c'));
  assert.equal(configDirectory('kimi', { KIMI_CODE_HOME: '/k' }, '/h'), path.resolve('/k'));
  assert.equal(configDirectory('kimi', {}, '/h'), path.resolve('/h/.kimi-code'));
  assert.equal(configDirectory('agy', {}, '/h'), path.resolve('/h/.gemini/config'));
});

test('Antigravity: missing, install with backup, current, exact undo', async () => {
  const t = await setup();
  try {
    const target = path.join(t.home, '.gemini', 'config', 'hooks.json');
    assert.deepEqual(await t.installer.status('agy'), { state: 'missing' });
    const plan = await t.installer.preview('agy');
    assert.equal(plan.target, target);
    assert.equal(plan.adds.length, 6);
    assert.deepEqual(plan.removes, []);
    const applied = await t.installer.apply();
    assert.equal(applied.backup, undefined);
    assert.deepEqual(await t.installer.status('agy'), { state: 'current' });
    await t.installer.undo();
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  } finally { await t.cleanup(); }
});
