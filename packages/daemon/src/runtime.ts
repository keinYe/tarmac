import net from 'node:net';
import path from 'node:path';
import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { acquireLease } from './lease.ts';
import type { Lease } from './lease.ts';

// Bound young-generation allocation churn without capping the old heap or
// changing agent runtimes. Keep launchers and resource measurements in sync.
export const DAEMON_NODE_FLAGS = ['--max-semi-space-size=8'] as const;

async function markDirectory(dataDir: string, socketPath: string): Promise<void> {
  const marker = path.join(dataDir, 'tarmac-runtime.json');
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 1024) throw new Error('unrecognized tarmac runtime marker');
    let saved;
    try { saved = JSON.parse(await readFile(marker, 'utf8')); }
    catch { throw new Error('invalid tarmac runtime marker'); }
    if (saved.app !== 'tarmac-app' || saved.version !== 1) throw new Error('unrecognized tarmac runtime marker');
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // An existing unknown endpoint is never adopted just because it has our filename.
  try { await lstat(socketPath); throw new Error('socket exists without tarmac ownership marker'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = path.join(dataDir, `runtime-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ app: 'tarmac-app', version: 1 }) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, marker);
}

async function listening(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('socket liveness is unknown')); }, 300);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

export async function claimRuntime(dataDir: string, socketPath: string): Promise<Lease> {
  const lease = await acquireLease(dataDir);
  try {
    await markDirectory(dataDir, socketPath);
    let before;
    try { before = await lstat(socketPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return lease; throw error; }
    if (!before.isSocket() || before.isSymbolicLink() || before.uid !== process.getuid?.()) throw new Error('existing socket path is not an owned socket');
    if (await listening(socketPath)) throw new Error('an active listener owns the socket');
    let after;
    try { after = await lstat(socketPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return lease; throw error; }
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('socket changed during recovery');
    // All participating daemons are excluded by the lease. A marked, owned socket
    // with no listener is ephemeral runtime state, not a registry or user record.
    await unlink(socketPath);
    return lease;
  } catch (error) { await lease.release(); throw error; }
}
