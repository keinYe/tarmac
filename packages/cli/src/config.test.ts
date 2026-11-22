import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { planConfig, applyConfigPlan, kimiConfigSnippet } from './config.ts';

async function directory(): Promise<string> {
  const root = path.resolve('.tmp/app-m0-validation');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'config-'));
}

test('Kimi snippet includes native lifecycle events, quoted commands and no extra TOML fields', () => {
  const command = "'/path with spaces/node' '/app/cli.cjs' hook kimi";
  const snippet = kimiConfigSnippet(command);
  const blocks = snippet.split('[[hooks]]\n').slice(1);
  assert.equal(blocks.length, 12);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[1].slice('command = '.length)), command + ' # tarmac-app');
    assert.equal(lines[2], 'timeout = 1');
  }
  for (const event of ['TurnStarted', 'PermissionResult', 'Stop', 'Interrupt']) assert.ok(snippet.includes(`event = "${event}"`));
  assert.throws(() => kimiConfigSnippet('bad\ncommand'), /single-line/);
});

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} plan is read-only and installation/uninstallation preserves other settings and hooks`, async () => {
    const dir = await directory();
    const target = path.join(dir, provider === 'claude' ? 'settings.json' : 'hooks.json');
    const original = { model: 'keep', secret: 'never-print', hooks: {
      Stop: [{ matcher: 'custom', hooks: [{ type: 'command', command: 'keep-original' }] }],
      FutureEvent: [{ hooks: [] }],
    } };
    await writeFile(target, JSON.stringify(original));
    try {
      const plan = await planConfig(provider, dir, 'install', "'/app/runtime' '/app/cli.cjs' hook " + provider);
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), original);
      assert.equal(JSON.stringify(plan).includes('never-print'), false);
      assert.equal(plan.requiresAgentTrust, provider === 'codex');
      if (provider === 'codex') {
        for (const event of ['PreModelRequest', 'PostModelRequest']) assert.ok(plan.changes.some(change => change.event === event && change.action === 'add'));
      }
      await applyConfigPlan(plan);
      const installed = JSON.parse(await readFile(target, 'utf8'));
      assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
      assert.deepEqual(installed.hooks.FutureEvent, original.hooks.FutureEvent);
      const again = await planConfig(provider, dir, 'install', "'/app/runtime' '/app/cli.cjs' hook " + provider);
      await applyConfigPlan(again);
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), installed);
      await applyConfigPlan(await planConfig(provider, dir, 'uninstall'));
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), original);
      assert.equal((await applyConfigPlan(await planConfig(provider, dir, 'uninstall'))).changed, false);
    } finally { await rm(dir, { recursive: true }); }
  });
}

test('new configuration remains untrusted for Codex and uninstall removes only owned entries', async () => {
  const dir = await directory();
  try {
    const plan = await planConfig('codex', dir, 'install', 'node /app/cli.cjs hook codex');
    assert.equal(plan.beforeHash, null);
    assert.equal(plan.requiresAgentTrust, true);
    await applyConfigPlan(plan);
    const config = JSON.parse(await readFile(plan.target, 'utf8'));
    assert.equal('trusted' in config, false);
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'unrelated-tarmac-helper' }] });
    await writeFile(plan.target, JSON.stringify(config));
    await applyConfigPlan(await planConfig('codex', dir, 'uninstall'));
    assert.deepEqual(JSON.parse(await readFile(plan.target, 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'unrelated-tarmac-helper' }] }] } });
  } finally { await rm(dir, { recursive: true }); }
});

test('stale or tampered plan refuses to overwrite configuration', async () => {
  const dir = await directory();
  try {
    const plan = await planConfig('claude', dir, 'install', 'node /app/cli.cjs hook claude');
    await writeFile(plan.target, '{"concurrent":true}');
    await assert.rejects(applyConfigPlan(plan), /changed since plan/);
    assert.equal(await readFile(plan.target, 'utf8'), '{"concurrent":true}');
    const fresh = await planConfig('claude', dir, 'install', 'node /app/cli.cjs hook claude');
    fresh.changes = [];
    await assert.rejects(applyConfigPlan(fresh), /changes do not match/);
  } finally { await rm(dir, { recursive: true }); }
});

test('explicit absolute directory, valid JSON shape and ordinary file are required', async () => {
  await assert.rejects(planConfig('claude', '.', 'install', 'node cli.cjs'), /absolute directory/);
  const dir = await directory();
  try {
    for (const text of ['[]', '{', '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
      await writeFile(path.join(dir, 'settings.json'), text);
      await assert.rejects(planConfig('claude', dir, 'install', 'node cli.cjs'));
    }
    const real = path.join(dir, 'real.json');
    await writeFile(real, '{}');
    await symlink(real, path.join(dir, 'hooks.json'));
    await assert.rejects(planConfig('codex', dir, 'install', 'node cli.cjs'), /regular file/);
    for (const command of ['', 'node cli\nsecret', 'node\0cli']) {
      await assert.rejects(planConfig('codex', path.join(dir, 'new'), 'install', command));
    }
  } finally { await rm(dir, { recursive: true }); }
});
