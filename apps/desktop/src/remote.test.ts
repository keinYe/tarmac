import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Daemon } from '../../../packages/daemon/src/server.ts';
import type { ServerEvent, SessionInfo } from '../../../packages/protocol/src/index.ts';
import { RemoteFailure, classifyExit, connectRemote, sshArgs, validHost } from './remote.ts';
import { HostStore, RemoteHost, checkHost, newHostId, splitId } from './hosts.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const base = path.join(root, '.tmp/app-m0-validation');
const fixture = path.join(root, 'packages/cli/test/bridge-fixture.ts');

// A stand-in for ssh: records its argv, then runs the remote command with sh, as sshd would.
async function setup() {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'r-'));
  const data = path.join(dir, 'data');
  const record = path.join(dir, 'ssh-args');
  const ssh = path.join(dir, 'ssh');
  await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nfor last; do :; done\nexec /bin/sh -c "$last"\n`);
  await chmod(ssh, 0o755);
  const deny = path.join(dir, 'ssh-deny');
  await writeFile(deny, '#!/bin/sh\necho "dev@192.168.1.20: Permission denied (publickey)." >&2\nexit 255\n');
  await chmod(deny, 0o755);
  let daemon = new Daemon(data);
  await daemon.start();
  return {
    dir, data, ssh, deny, record,
    host: (version = '0.1.0') => ({ name: 'ws', address: '192.168.1.20', user: 'dev', port: 2222,
      command: `${process.execPath} --experimental-strip-types ${fixture} ${data} ${version}` }),
    async restart() { daemon = new Daemon(data); await daemon.start(); },
    stop: () => daemon.stop(),
    async cleanup() { await daemon.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error('condition not reached');
}

test('host fields that ssh could read as options are refused; argv is fixed', () => {
  assert.equal(validHost({ name: 'ws', address: '-oProxyCommand=touch x' }), false);
  assert.equal(validHost({ name: 'ws', address: 'ws', user: '-l' }), false);
  assert.equal(validHost({ name: 'ws', address: 'ws lan' }), false);
  assert.equal(validHost({ name: 'ws', address: 'ws', port: 70000 }), false);
  assert.equal(validHost({ name: 'ws', address: 'ws', command: 'bridge\nrm -rf ~' }), false);
  assert.equal(validHost({ name: 'ws', address: '192.168.1.20', user: 'dev', port: 22 }), true);
  const args = sshArgs({ name: 'ws', address: 'ws.lan' });
  assert.deepEqual(args.slice(-3), ['--', 'ws.lan', args.at(-1)]);
  assert.ok(args.includes('BatchMode=yes'));
  assert.match(args.at(-1)!, /\.local\/opt\/tarmac\/Tarmac" .*cli\.cjs" bridge$/);
});

test('ssh failures are told apart by exit code and message', () => {
  assert.equal(classifyExit(255, 'dev@ws: Permission denied (publickey,password).').kind, 'auth');
  assert.equal(classifyExit(255, 'Host key verification failed.').kind, 'hostkey');
  assert.equal(classifyExit(255, 'ssh: connect to host ws port 22: Connection refused').kind, 'unreachable');
  assert.equal(classifyExit(255, 'ssh: Could not resolve hostname ws: Name or service not known').kind, 'unreachable');
  assert.equal(classifyExit(127, 'sh: 1: /home/dev/.local/opt/tarmac/Tarmac: not found').kind, 'missing');
  assert.equal(classifyExit(1, 'daemon did not start').kind, 'bridge');
});

test('a remote daemon is reached through ssh and the bridge, and a version mismatch is refused', async () => {
  const t = await setup();
  try {
    const { client, header } = await connectRemote(t.host(), { version: '0.1.0', ssh: t.ssh });
    try {
      assert.equal(header.daemon, 'running');
      assert.deepEqual(await client.request({ type: 'list' }), []);
      const args = (await readFile(t.record, 'utf8')).trim().split('\n');
      assert.deepEqual(args.slice(-3, -1), ['--', 'dev@192.168.1.20']);
      assert.ok(args.includes('-p') && args.includes('2222'));
    } finally { client.close(); }
    await assert.rejects(connectRemote(t.host('0.2.0'), { version: '0.1.0', ssh: t.ssh }),
      (error: unknown) => error instanceof RemoteFailure && error.kind === 'version' && error.remoteVersion === '0.2.0');
  } finally { await t.cleanup(); }
});

test('the add-host checklist names the failing step', async () => {
  const t = await setup();
  try {
    const passed = await checkHost(t.host(), { version: '0.1.0', ssh: t.ssh });
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.steps.map(step => step.label), ['SSH 登录', '找到 Tarmac 0.1.0', '版本与本机一致', 'daemon 运行中']);
    const denied = await checkHost(t.host(), { version: '0.1.0', ssh: t.deny });
    assert.deepEqual(denied.steps.map(step => [step.label, step.ok]), [['SSH 登录', false]]);
    const missing = await checkHost({ ...t.host(), command: 'tarmac-missing-for-test bridge' }, { version: '0.1.0', ssh: t.ssh });
    assert.deepEqual(missing.steps.map(step => [step.label, step.ok]), [['SSH 登录', true], ['找到 Tarmac', false]]);
    const old = await checkHost(t.host('0.0.9'), { version: '0.1.0', ssh: t.ssh });
    assert.deepEqual(old.steps.map(step => step.ok), [true, true, false]);
  } finally { await t.cleanup(); }
});

test('a remote host prefixes its sessions, and reconnects after its daemon comes back', async () => {
  const t = await setup();
  const remote = new RemoteHost({ id: 'h0000beef', ...t.host() }, { version: '0.1.0', ssh: t.ssh });
  const events: ServerEvent[] = [];
  remote.on('event', event => events.push(event));
  try {
    remote.start();
    await waitFor(() => remote.view().state === 'connected');
    assert.equal(remote.view().shell?.command !== undefined, true);
    const info = await remote.connection!.request<SessionInfo>({ type: 'create', options: {
      command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: t.dir, cols: 80, rows: 24 } });
    await waitFor(() => events.some(event => event.type === 'info'));
    const prefixed = events.find(event => event.type === 'info');
    assert.ok(prefixed?.type === 'info');
    assert.deepEqual(splitId(prefixed.session.sessionId), { host: 'h0000beef', sessionId: info.sessionId });
    assert.equal((prefixed.session as SessionInfo & { host?: string }).host, 'h0000beef');
    await t.stop();
    await waitFor(() => remote.view().state === 'waiting' || remote.view().state === 'connecting');
    await t.restart();
    await waitFor(() => remote.view().state === 'connected', 15_000);
    remote.stop('已手动断开');
    assert.equal(remote.view().state, 'stopped');
    assert.equal(remote.connection, null);
  } finally { remote.stop(); await t.cleanup(); }
});

test('host configuration round-trips and invalid entries are dropped on load', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'r-'));
  try {
    const store = new HostStore(path.join(dir, 'hosts.json'));
    assert.deepEqual(await store.load(), []);
    const id = newHostId();
    await store.save([{ id, name: 'ws', address: '192.168.1.20', user: 'dev', port: 22 }]);
    assert.deepEqual(await store.load(), [{ id, name: 'ws', address: '192.168.1.20', user: 'dev', port: 22 }]);
    await writeFile(path.join(dir, 'hosts.json'), JSON.stringify({ v: 1, hosts: [{ id, name: 'ws', address: 'ws' },
      { id: 'local', name: 'x', address: 'x' }, { id: newHostId(), name: 'bad', address: '-oProxyCommand=x' }] }));
    assert.deepEqual((await store.load()).map(host => host.id), [id]);
    assert.deepEqual(splitId('s1'), { host: 'local', sessionId: 's1' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
