import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { planAgyConfig, applyAgyPlan, targetForAgy, AGY_EVENTS } from './agy-config.ts';

async function directory(): Promise<string> {
  const root = path.resolve('.tmp/app-m0-validation');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'agy-config-'));
}

test('Antigravity plan is read-only and install preserves other user hooks', async () => {
  const dir = await directory();
  const target = targetForAgy(dir);
  const original = {
    'lint-checker': {
      PostToolUse: [
        { matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] },
      ],
    },
  };
  await writeFile(target, JSON.stringify(original));
  try {
    const plan = await planAgyConfig(dir, 'install', 'tarmac hook agy');
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), original);
    assert.equal(plan.provider, 'agy');
    assert.equal(plan.changes.length, AGY_EVENTS.length);
    assert.ok(plan.changes.every(c => c.action === 'add'));

    await applyAgyPlan(plan);
    const installed = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(installed['lint-checker'], original['lint-checker']);
    assert.ok(installed.tarmac);
    assert.equal(installed.tarmac.PreInvocation[0].command, 'tarmac hook agy # tarmac-app');
    assert.equal(installed.tarmac.PreToolUse[0].hooks[0].command, 'tarmac hook agy # tarmac-app');

    // Re-plan should detect current hooks (removes === adds)
    const replan = await planAgyConfig(dir, 'install', 'tarmac hook agy');
    assert.equal(replan.changes.filter(c => c.action === 'remove').length, AGY_EVENTS.length);
    assert.equal(replan.changes.filter(c => c.action === 'add').length, AGY_EVENTS.length);

    // Uninstall
    const unplan = await planAgyConfig(dir, 'uninstall');
    assert.equal(unplan.changes.length, AGY_EVENTS.length);
    assert.ok(unplan.changes.every(c => c.action === 'remove'));
    await applyAgyPlan(unplan);

    const afterUninstall = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(afterUninstall, original);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Antigravity install and uninstall leave unmarked content, including a user "tarmac" hook name, untouched', async () => {
  const dir = await directory();
  const target = targetForAgy(dir);
  const original = {
    empty: {},
    'empty-event': { Stop: [] },
    'empty-group': { PreToolUse: [{ matcher: '*', hooks: [] }] },
    tarmac: { Stop: [{ type: 'command', command: './notify.sh' }] },
  };
  await writeFile(target, JSON.stringify(original));
  try {
    await applyAgyPlan(await planAgyConfig(dir, 'install', 'tarmac hook agy'));
    const installed = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(installed.empty, original.empty);
    assert.deepEqual(installed['empty-event'], original['empty-event']);
    assert.deepEqual(installed['empty-group'], original['empty-group']);
    assert.deepEqual(installed.tarmac.Stop.map((handler: { command: string }) => handler.command),
      ['./notify.sh', 'tarmac hook agy # tarmac-app']);
    assert.equal(installed.tarmac.PreToolUse[0].hooks[0].command, 'tarmac hook agy # tarmac-app');

    await applyAgyPlan(await planAgyConfig(dir, 'uninstall'));
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), original);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Antigravity plan refuses stale configuration hash or invalid commands', async () => {
  const dir = await directory();
  try {
    for (const bad of ['', 'cmd\nnewline', 'cmd\0null']) {
      await assert.rejects(planAgyConfig(dir, 'install', bad), /single-line/);
    }
    const plan = await planAgyConfig(dir, 'install', 'tarmac hook agy');
    await writeFile(plan.target, '{"tampered": true}');
    await assert.rejects(applyAgyPlan(plan), /configuration changed/);
  } finally {
    await rm(dir, { recursive: true });
  }
});
