import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyKimiPlan, kimiTransform, planKimiConfig } from './kimi-config.ts';
import { packagedCli, packagedHookCommand } from './hook-command.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
const USER = `default_model = "kimi-code/k3"

[models."kimi-code/k3"]
provider = "managed:kimi-code"

[[hooks]]
event = "UserPromptSubmit"
command = "my-own-hook"
timeout = 2

# search settings
[services.moonshot_search]
enabled = true
`;

test('Kimi install appends owned blocks and uninstall restores the exact file', () => {
  const installed = kimiTransform(USER, 'install', '/app/cli hook kimi');
  assert.equal(installed.changes.filter(change => change.action === 'add').length, 12);
  assert.equal(installed.changes.filter(change => change.action === 'remove').length, 0);
  assert.ok(installed.text.startsWith(USER), 'user content is kept byte for byte');
  assert.match(installed.text, /command = "\/app\/cli hook kimi # tarmac-app"/);
  const removed = kimiTransform(installed.text, 'uninstall');
  assert.equal(removed.changes.length, 12);
  assert.equal(removed.text, USER);
});

test('reinstalling replaces stale owned blocks anywhere and keeps the user hook and comments', () => {
  const stale = kimiTransform(USER, 'install', '/old/cli hook kimi').text;
  // An owned block between user tables, followed by a comment that belongs to the next table.
  const middle = USER.replace('# search settings', '[[hooks]]\nevent = "Stop"\ncommand = "/old/cli hook kimi # tarmac-app"\ntimeout = 1\n\n# search settings');
  for (const text of [stale, middle]) {
    const next = kimiTransform(text, 'install', '/new/cli hook kimi');
    assert.ok(next.changes.some(change => change.action === 'remove' && change.command === '/old/cli hook kimi # tarmac-app'));
    assert.doesNotMatch(next.text, /\/old\/cli/);
    assert.match(next.text, /command = "my-own-hook"/);
    assert.match(next.text, /# search settings\n\[services\.moonshot_search\]/);
    assert.equal(kimiTransform(next.text, 'uninstall').text, USER);
  }
});

test('CRLF files stay CRLF', () => {
  const crlf = USER.replaceAll('\n', '\r\n');
  const installed = kimiTransform(crlf, 'install', 'x hook kimi').text;
  assert.doesNotMatch(installed.replaceAll('\r\n', ''), /\n/);
  assert.equal(kimiTransform(installed, 'uninstall').text, crlf);
});

test('block-level editing refuses what it cannot handle safely', () => {
  assert.throws(() => kimiTransform('prompt = """\n[[hooks]]\n"""\n', 'install', 'x'), /multi-line strings/);
  const edited = '[[hooks]]\nevent = "Stop"\n# my note\ncommand = "x # tarmac-app"\n';
  assert.throws(() => kimiTransform(edited, 'uninstall'), /edited by hand/);
  assert.throws(() => kimiTransform(USER, 'install', 'bad\ncommand'), /single-line/);
});

test('Kimi plans apply only to the unchanged file they were made from', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'kimi-'));
  try {
    await assert.rejects(planKimiConfig(dir, 'install', 'x hook kimi'), /请先运行一次 Kimi/);
    const target = path.join(dir, 'config.toml');
    await writeFile(target, USER);
    const plan = await planKimiConfig(dir, 'install', 'x hook kimi');
    await writeFile(target, USER + '\n# edited\n');
    await assert.rejects(applyKimiPlan(plan), /changed since plan/);
    await writeFile(target, USER);
    assert.deepEqual(await applyKimiPlan(await planKimiConfig(dir, 'install', 'x hook kimi')), { target, changed: true });
    assert.match(await readFile(target, 'utf8'), /x hook kimi # tarmac-app/);
    await applyKimiPlan(await planKimiConfig(dir, 'uninstall'));
    assert.equal(await readFile(target, 'utf8'), USER);
    assert.equal((await applyKimiPlan(await planKimiConfig(dir, 'uninstall'))).changed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('packaged hook commands match the installed form on each platform', () => {
  assert.equal(packagedHookCommand({ platform: 'linux', execPath: '/home/me/.local/opt/tarmac/Tarmac', resourcesPath: '/home/me/.local/opt/tarmac/resources' }, 'kimi'),
    "env ELECTRON_RUN_AS_NODE=1 '/home/me/.local/opt/tarmac/Tarmac' '/home/me/.local/opt/tarmac/resources/app/dist/cli.cjs' hook kimi");
  assert.equal(packagedCli({ platform: 'darwin', execPath: "/A's/Tarmac", resourcesPath: "/A's/Resources" }),
    "env ELECTRON_RUN_AS_NODE=1 '/A'\\''s/Tarmac' '/A'\\''s/Resources/app/dist/cli.cjs'");
  assert.equal(packagedHookCommand({ platform: 'win32', execPath: 'D:\\Tools\\Tarmac\\Tarmac.exe', resourcesPath: 'D:\\Tools\\Tarmac\\resources' }, 'claude'),
    '"D:/Tools/Tarmac/resources/app/dist/native/tarmac-native.exe" cli hook claude');
});
