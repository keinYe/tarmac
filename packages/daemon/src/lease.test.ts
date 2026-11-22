import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir, symlink, readlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawn, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquireLease } from './lease.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
async function temporary() { await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'lease-')); }

test('a live owner excludes concurrent startups and releasing never reuses a ticket', async () => {
  const dir = await temporary();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireLease(dir)));
    const owners = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    assert.equal(owners.length, 1);
    await owners[0].release();
    await owners[0].release();
    const next = await acquireLease(dir);
    const names = await readdir(path.join(dir, 'daemon-leases'));
    assert.equal(names.filter(name => name.endsWith('.lease')).length, 13);
    assert.ok(names.includes('00000000000000000013.lease'));
    await next.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an atomically recorded dead owner can be recovered without deleting prior metadata', async () => {
  const dir = await temporary();
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    assert.ok(child.pid);
    await new Promise(resolve => child.once('exit', resolve));
    const ledger = path.join(dir, 'daemon-leases');
    await mkdir(ledger, { mode: 0o700 });
    const old = `tarmac:active:${child.pid}:${randomUUID()}:${'0'.repeat(64)}`;
    await symlink(old, path.join(ledger, '00000000000000000001.lease'));
    const next = await acquireLease(dir);
    assert.equal(await readlink(path.join(ledger, '00000000000000000001.lease')), old);
    await next.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a reused PID with a different process start identity does not block recovery', async () => {
  const dir = await temporary();
  try {
    const ledger = path.join(dir, 'daemon-leases');
    await mkdir(ledger, { mode: 0o700 });
    const stale = `tarmac:active:${process.pid}:${randomUUID()}:${'0'.repeat(64)}`;
    await symlink(stale, path.join(ledger, '00000000000000000001.lease'));
    const next = await acquireLease(dir);
    await next.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown ledger entries and symlink directories are preserved and refuse recovery', async () => {
  const dir = await temporary();
  try {
    const ledger = path.join(dir, 'daemon-leases');
    await mkdir(ledger, { mode: 0o700 });
    await symlink('unrecognized-target', path.join(ledger, '00000000000000000001.lease'));
    await assert.rejects(acquireLease(dir), /invalid daemon lease/);
    assert.equal(await readlink(path.join(ledger, '00000000000000000001.lease')), 'unrecognized-target');
    const other = await temporary();
    try {
      await symlink(ledger, path.join(other, 'daemon-leases'));
      await assert.rejects(acquireLease(other), /private directory/);
      assert.equal((await lstat(path.join(other, 'daemon-leases'))).isSymbolicLink(), true);
    } finally { await rm(other, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('independent processes elect exactly one writer under simultaneous startup', async () => {
  const dir = await temporary();
  const children = Array.from({ length: 8 }, () => fork(path.resolve(import.meta.dirname, '../test/lease-holder.ts'), [dir], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  const exits = children.map(child => new Promise(resolve => child.once('exit', resolve)));
  try {
    const results = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lease child did not report a result')), 5000);
      child.once('message', message => { clearTimeout(timer); resolve((message as { type: string }).type); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    })));
    assert.equal(results.filter(result => result === 'acquired').length, 1);
    const owner = children[results.indexOf('acquired')];
    owner.send('release');
    await Promise.all(exits);
    const next = await acquireLease(dir);
    await next.release();
  } finally {
    children.forEach(child => { if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM'); });
    await Promise.all(exits);
    await rm(dir, { recursive: true, force: true });
  }
});
