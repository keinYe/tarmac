import { mkdir, lstat, readdir, readlink, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TICKET = /^\d{20}\.lease$/;
const TARGET = /^tarmac:(active|released):(\d+):([0-9a-f-]{36}):([0-9a-f]{64})$/;

export interface Lease { release(): Promise<void> }

function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid lease process id');
  try {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    const details = execFileSync('ps', ['-o', 'uid=,lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim().match(/^(\d+)\s+(.+)$/);
    if (!details) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; }
      throw new Error('cannot verify daemon lease process identity');
    }
    if (Number(details[1]) !== process.getuid?.()) return undefined;
    return createHash('sha256').update(details[2]).digest('hex');
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    try { process.kill(pid, 0); }
    catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return undefined; }
    throw error;
  }
}

// Tickets are never reused. A symlink creates the owner metadata atomically,
// including when the owner dies immediately after allocation. No target is followed.
export async function acquireLease(dataDir: string): Promise<Lease> {
  const directory = path.join(dataDir, 'daemon-leases');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('daemon leases must be an owned private directory');
  }
  const files = (await readdir(directory)).filter(name => TICKET.test(name));
  let sequence = files.reduce((max, name) => { const number = BigInt(name.slice(0, 20)); return number > max ? number : max; }, 0n);
  const nonce = randomUUID();
  const selfIdentity = processIdentity(process.pid);
  if (!selfIdentity) throw new Error('cannot verify current daemon process identity');
  const owner = `tarmac:active:${process.pid}:${nonce}:${selfIdentity}`;
  let ticket: string;
  for (;;) {
    sequence++;
    if (sequence >= 10n ** 20n) throw new Error('daemon lease ticket space exhausted');
    ticket = path.join(directory, `${String(sequence).padStart(20, '0')}.lease`);
    try { await symlink(owner, ticket); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  let released = false;
  const lease: Lease = {
    async release() {
      if (released) return;
      if (await readlink(ticket) !== owner) throw new Error('daemon lease ownership changed');
      const temporary = path.join(directory, `${nonce}.release`);
      await symlink(`tarmac:released:${process.pid}:${nonce}:${selfIdentity}`, temporary);
      await rename(temporary, ticket);
      released = true;
    },
  };
  try {
    // Every lower ticket existed before ours; later contenders can only get a
    // higher ticket and must observe this live owner before accessing the journal.
    for (const name of await readdir(directory)) {
      if (!TICKET.test(name) || BigInt(name.slice(0, 20)) >= sequence) continue;
      const filename = path.join(directory, name);
      const entry = await lstat(filename);
      if (!entry.isSymbolicLink() || entry.uid !== process.getuid?.()) throw new Error('unrecognized daemon lease entry');
      const value = await readlink(filename);
      const parsed = TARGET.exec(value);
      if (!parsed) throw new Error('invalid daemon lease owner');
      if (parsed[1] === 'active' && processIdentity(Number(parsed[2])) === parsed[4]) throw new Error('another live daemon owns this data directory');
    }
    return lease;
  } catch (error) { await lease.release(); throw error; }
}
