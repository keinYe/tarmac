import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import ssh2 from 'ssh2';
import { Daemon } from '../../../packages/daemon/src/server.ts';
import { deployKey, ensureKey, knownName, probeHost, trustHost } from './first-connect.ts';
import { checkHost, revokeKey } from './hosts.ts';
import { connectRemote, optionPath, sshFiles, untilReady } from './remote.ts';
import { startTestSshServer } from './ssh-test-server.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, '.tmp/app-m0-validation');
const fixture = path.join(root, 'packages/cli/test/bridge-fixture.ts');
const { utils } = ssh2;

async function setup() {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'f-'));
  const home = path.join(dir, 'home');
  await mkdir(home);
  const server = await startTestSshServer({ user: 'dev', password: 'secret', home });
  const port = server.port;
  const files = sshFiles(path.join(dir, 'local-ssh'));
  const data = path.join(dir, 'data');
  const daemon = new Daemon(data);
  await daemon.start();
  return { dir, home, files, port, data,
    target: { name: 'ws', address: '127.0.0.1', user: 'dev', port, command: `${process.execPath} --experimental-strip-types ${fixture} ${data} 0.1.0` },
    authorized: () => readFile(path.join(home, '.ssh/authorized_keys'), 'utf8'),
    async cleanup() { server.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); } };
}

test('host key is probed, confirmed into tarmac_known_hosts in a form ssh reads, and a changed key is reported', async () => {
  const t = await setup();
  try {
    const first = await probeHost(t.target, t.files);
    assert.equal(first.status, 'unknown');
    assert.equal(first.key.type, 'ssh-ed25519');
    assert.match(first.key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    await trustHost(t.target, first.key, t.files);
    assert.equal(knownName(t.target), `[127.0.0.1]:${t.port}`);
    assert.match(execFileSync('ssh-keygen', ['-F', knownName(t.target), '-f', t.files.knownHosts], { encoding: 'utf8' }), /ssh-ed25519/);
    assert.equal((await probeHost(t.target, t.files)).status, 'match');
    // Another key recorded for the same name: the next probe says it changed and shows the old one.
    const other = utils.parseKey(utils.generateKeyPairSync('ed25519').public);
    assert.ok(!(other instanceof Error) && !Array.isArray(other));
    await writeFile(t.files.knownHosts, `${knownName(t.target)} ssh-ed25519 ${other.getPublicSSH().toString('base64')}\n`);
    const changed = await probeHost(t.target, t.files);
    assert.equal(changed.status, 'changed');
    assert.equal(changed.previous.length, 1);
    assert.notEqual(changed.previous[0], changed.key.fingerprint);
    await trustHost(t.target, changed.key, t.files);
    assert.equal((await readFile(t.files.knownHosts, 'utf8')).trim().split('\n').length, 1, 'the old record is replaced, not kept');
  } finally { await t.cleanup(); }
});

test('a password login deploys the Tarmac key once, keeps existing lines, and the system ssh then logs in with it', async () => {
  const t = await setup();
  try {
    await assert.rejects(deployKey(t.target, 'secret', t.files), /先确认这台主机的指纹/, 'no password is sent to an unconfirmed host');
    await trustHost(t.target, (await probeHost(t.target, t.files)).key, t.files);
    // Key login fails before deployment and the checklist offers the first connection.
    const before = await checkHost(t.target, { version: '0.1.0', files: t.files });
    assert.equal(before.firstConnect, true);
    await assert.rejects(deployKey(t.target, 'wrong', t.files), /密码不正确/);
    await mkdir(path.join(t.home, '.ssh'), { mode: 0o700 });
    await writeFile(path.join(t.home, '.ssh/authorized_keys'), 'ssh-ed25519 AAAAexisting other@laptop', { mode: 0o600 });
    const line = await deployKey(t.target, 'secret', t.files);
    assert.match(line, /^ssh-ed25519 \S+ tarmac-app$/, 'the line does not name this machine');
    assert.equal(await t.authorized(), `ssh-ed25519 AAAAexisting other@laptop\n${line}\n`, 'appended on its own line');
    await deployKey(t.target, 'secret', t.files);
    assert.equal(await t.authorized(), `ssh-ed25519 AAAAexisting other@laptop\n${line}\n`, 'not appended twice');
    // ssh-keygen reads the generated private key and derives the same public key.
    assert.equal(execFileSync('ssh-keygen', ['-y', '-f', t.files.key], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' '),
      line.split(' ').slice(0, 2).join(' '));
    assert.equal(await ensureKey(t.files), line, 'an existing key is reused');
    // Everyday path: the system ssh with -i and tarmac_known_hosts, BatchMode, through the bridge.
    const { client, header } = await connectRemote(t.target, { version: '0.1.0', files: t.files });
    try {
      assert.equal(header.daemon, 'running');
      await untilReady(client);
      assert.deepEqual(await client.request({ type: 'list' }), []);
    } finally { client.close(); }
    assert.equal((await checkHost(t.target, { version: '0.1.0', files: t.files })).ok, true);
    await revokeKey(t.target, { files: t.files });
    assert.equal(await t.authorized(), 'ssh-ed25519 AAAAexisting other@laptop\n', 'only the Tarmac line is removed');
    assert.equal((await checkHost(t.target, { version: '0.1.0', files: t.files })).firstConnect, true, 'the key no longer logs in');
  } finally { await t.cleanup(); }
});

test('a host key already in the user known_hosts is accepted for the password login without a second confirmation', async () => {
  const t = await setup();
  try {
    const { key } = await probeHost(t.target, t.files);
    await mkdir(path.dirname(t.files.userKnownHosts), { recursive: true });
    await writeFile(t.files.userKnownHosts, `${knownName(t.target)} ${key.type} ${key.blob.toString('base64')}\n`);
    assert.equal((await probeHost(t.target, t.files)).status, 'match');
    assert.match(await deployKey(t.target, 'secret', t.files), / tarmac-app$/);
    assert.equal((await checkHost(t.target, { version: '0.1.0', files: t.files })).ok, true);
  } finally { await t.cleanup(); }
});

test('a line of this key written with the machine name is replaced on deploy and removed on revoke', async () => {
  const t = await setup();
  try {
    await trustHost(t.target, (await probeHost(t.target, t.files)).key, t.files);
    const key = (await ensureKey(t.files)).split(' ').slice(0, 2).join(' ');
    await mkdir(path.join(t.home, '.ssh'), { mode: 0o700 });
    await writeFile(path.join(t.home, '.ssh/authorized_keys'), `ssh-ed25519 AAAAexisting other@laptop\n${key} tarmac-app@DESKTOP-WIN11\n`, { mode: 0o600 });
    await deployKey(t.target, 'secret', t.files);
    assert.equal(await t.authorized(), `ssh-ed25519 AAAAexisting other@laptop\n${key} tarmac-app\n`);
    await writeFile(path.join(t.home, '.ssh/authorized_keys'), `${key} tarmac-app@DESKTOP-WIN11\nssh-ed25519 AAAAexisting other@laptop\n${key} tarmac-app\n`);
    await revokeKey(t.target, { files: t.files });
    assert.equal(await t.authorized(), 'ssh-ed25519 AAAAexisting other@laptop\n');
  } finally { await t.cleanup(); }
});

test('Windows paths reach ssh options with forward slashes and quotes around spaces', () => {
  assert.equal(optionPath('C:\\Users\\Jane Doe\\.ssh\\tarmac_known_hosts', 'win32'), '"C:/Users/Jane Doe/.ssh/tarmac_known_hosts"');
  assert.equal(optionPath('C:\\Users\\dev\\.ssh\\known_hosts', 'win32'), 'C:/Users/dev/.ssh/known_hosts');
  assert.equal(optionPath('/home/dev/a\\b', 'linux'), '/home/dev/a\\b');
});

test('a host that cannot be resolved names the reason; config aliases are not supported for the first connection', async () => {
  const files = sshFiles(path.join(base, 'no-such-dir'));
  await assert.rejects(probeHost({ address: 'tarmac-no-such-host.invalid' }, files), /不支持 ~\/\.ssh\/config 里的别名/);
});
