import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Daemon } from './server.ts';
import { SessionContext } from './session.ts';
import { Client } from '../../protocol/src/client.ts';
import type { SessionInfo, DesktopExitResult } from '../../protocol/src/index.ts';
import { exitDesktop } from '../../../apps/desktop/src/exit.ts';

const root = path.resolve(import.meta.dirname, '../../..');
async function setup() {
  const base = path.join(root, '.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'exit-'));
  const daemon = new Daemon(dir);
  await daemon.start();
  const clients: Client[] = [];
  const connect = async (desktop = true) => {
    const c = await Client.connect(daemon.socketPath);
    clients.push(c);
    if (desktop) await c.request({ type: 'desktop-register' });
    return c;
  };
  return { dir, daemon, connect, async cleanup() { clients.forEach(c => c.close()); await daemon.stop(); await rm(dir, { recursive: true, force: true }); } };
}
const options = { command: process.execPath, args: [path.join(root, 'packages/daemon/test/fake-agent.mjs')],
  cwd: root, cols: 80, rows: 24, env: { CLAUDE_CONFIG_DIR: path.join(root, '.tmp/app-m0-validation/no-hooks') } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('only registered App connections affect exit; an empty last window stops its daemon', async () => {
  const t = await setup();
  try {
    const observer = await t.connect(false);
    await assert.rejects(observer.request({ type: 'desktop-exit', confirmed: true }), /not registered/);
    const desktop = await t.connect();
    assert.equal(await exitDesktop(desktop, async () => assert.fail('no sessions'), () => {}), true);
    await t.daemon.stop();
    const restarted = new Daemon(t.dir);
    await restarted.start();
    try { assert.deepEqual(restarted.list(), []); }
    finally { await restarted.stop(); }
  } finally { await t.cleanup(); }
});

test('cancel preserves App sessions; confirmation ends owned PTYs while an external process survives', async () => {
  const t = await setup();
  const external = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const externalEnded = once(external, 'exit');
  try {
    const desktop = await t.connect();
    const session = await desktop.request<SessionInfo>({ type: 'create', options });
    assert.equal(await exitDesktop(desktop, async () => false, () => assert.fail('cancel')), false);
    assert.equal((await desktop.request<SessionInfo[]>({ type: 'list' }))[0].alive, true);
    assert.ok(alive(session.pid));
    assert.equal(await exitDesktop(desktop, async () => true, () => {}), true);
    await t.daemon.stop();
    assert.equal(alive(session.pid), false);
    assert.ok(external.pid && alive(external.pid), 'separately launched process must not be killed');
  } finally { external.kill(); await externalEnded; await t.cleanup(); }
});

test('two simultaneous window exits stop only after the final window confirms', async () => {
  const t = await setup();
  try {
    const a = await t.connect(); const b = await t.connect();
    const observer = await t.connect(false);
    const session = await a.request<SessionInfo>({ type: 'create', options });
    let confirmations = 0;
    const confirm = async () => { confirmations++; return true; };
    assert.deepEqual(await Promise.all([exitDesktop(a, confirm, () => {}), exitDesktop(b, confirm, () => {})]), [true, true]);
    await t.daemon.stop();
    assert.equal(confirmations, 1);
    assert.equal(alive(session.pid), false);
    await observer.waitForDisconnect();
  } finally { await t.cleanup(); }
});

test('a new window arriving during confirmation prevents daemon shutdown', async () => {
  const t = await setup();
  try {
    const a = await t.connect();
    const session = await a.request<SessionInfo>({ type: 'create', options });
    let b: Client | undefined;
    assert.equal(await exitDesktop(a, async () => { b = await t.connect(); return true; }, () => {}), true);
    const sessions = await b!.request<SessionInfo[]>({ type: 'list' });
    assert.equal(sessions[0].pid, session.pid);
    assert.equal(sessions[0].alive, true);
    assert.equal(await b!.request<DesktopExitResult>({ type: 'desktop-exit' }), 'confirmation-required');
  } finally { await t.cleanup(); }
});

test('unexpected App disconnect preserves sessions and can reconnect as the sole window', async () => {
  const t = await setup();
  try {
    const a = await t.connect();
    const session = await a.request<SessionInfo>({ type: 'create', options });
    a.close();
    const b = await t.connect();
    const deadline = Date.now() + 2000;
    while ((await b.request<{ desktops: number }>({ type: 'desktop-register' })).desktops !== 1) {
      assert.ok(Date.now() < deadline, 'disconnected desktop registration must be released');
      await delay(10);
    }
    assert.equal((await b.request<SessionInfo[]>({ type: 'list' }))[0].pid, session.pid);
    assert.ok(alive(session.pid));
    assert.equal(await b.request<DesktopExitResult>({ type: 'desktop-exit' }), 'confirmation-required');
  } finally { await t.cleanup(); }
});

test('exit waits for an in-flight creation and cleans up its PTY before shutdown completes', async () => {
  const t = await setup();
  const original = SessionContext.spawn;
  let release = () => {};
  let entered = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const spawned = new Promise<void>(resolve => { entered = resolve; });
  let pid = 0;
  SessionContext.spawn = async (...args) => {
    const context = await original(...args);
    pid = context.info.pid;
    entered();
    await barrier;
    return context;
  };
  try {
    const desktop = await t.connect();
    const pending = desktop.request({ type: 'create', options }).catch(error => error);
    await spawned;
    assert.equal(await desktop.request<DesktopExitResult>({ type: 'desktop-exit' }), 'confirmation-required');
    assert.equal(await desktop.request<DesktopExitResult>({ type: 'desktop-exit', confirmed: true }), 'shutdown');
    await assert.rejects(desktop.request({ type: 'desktop-register' }), /shutting down/);
    release();
    await desktop.waitForDisconnect();
    await t.daemon.stop();
    assert.match(String(await pending), /shutting down|disconnected/);
    assert.equal(alive(pid), false);
  } finally { release(); SessionContext.spawn = original; await t.cleanup(); }
});
