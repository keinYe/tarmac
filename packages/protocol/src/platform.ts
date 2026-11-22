import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Platform differences of the App's local transport and file ownership. Business code asks here
// instead of building socket paths or checking uid and mode bits itself.

export const TOKEN_FILE = 'daemon.token';

// A Windows named pipe has a default DACL that grants Everyone read access, and the pipe name
// space can be listed by any user, so a peer must present the token from the private data
// directory before it receives any frame. POSIX sockets live in a 0700 directory instead.
export const tokenRequired = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32';

export function endpointPath(dataDir: string, platform: NodeJS.Platform = process.platform, user = os.userInfo().username): string {
  if (platform === 'win32') {
    // The same data directory must map to the same pipe regardless of spelling.
    const key = `${user.toLowerCase()}\0${path.win32.resolve(dataDir).toLowerCase()}`;
    return `\\\\.\\pipe\\tarmac-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  }
  const socket = path.join(path.resolve(dataDir), 'daemon.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('socket path must be at most 100 bytes; choose a shorter data directory');
  return socket;
}

// The daemon data directory the App uses by default: Electron's userData for the name
// `tarmac-app` (set in apps/desktop/src/main.ts), then `m0`. TARMAC_DATA_DIR replaces it.
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  home = os.homedir()): string {
  const local = platform === 'win32' ? path.win32 : path.posix;
  const config = platform === 'win32' ? env.APPDATA || local.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? local.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME && local.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : local.join(home, '.config');
  return local.join(config, 'tarmac-app', 'm0');
}

export interface Endpoint { path: string; token?: string }

// Clients send a token only where the daemon requires it: a POSIX daemon of an older version
// stays running across App upgrades and would reject an unknown request type.
export function readEndpoint(dataDir: string, platform: NodeJS.Platform = process.platform): Endpoint {
  const endpoint: Endpoint = { path: endpointPath(dataDir, platform) };
  if (!tokenRequired(platform)) return endpoint;
  try {
    const token = readFileSync(path.join(dataDir, TOKEN_FILE), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(token)) endpoint.token = token;
  } catch { /* The daemon has not started yet; connecting will fail and be retried. */ }
  return endpoint;
}

export const newToken = (): string => randomBytes(32).toString('hex');

export function sameToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function writeToken(dataDir: string, token: string): Promise<void> {
  const temporary = path.join(dataDir, `${TOKEN_FILE}.${process.pid}.tmp`);
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(token + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path.join(dataDir, TOKEN_FILE));
}

// Windows has no uid in Stats; the per-user profile ACL protects the App data directory.
export function ownedByCurrentUser(stat: Stats, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return true;
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

// Windows cannot fsync a directory: FlushFileBuffers needs write access a directory handle lacks,
// so it fails with EPERM. NTFS journals the rename itself; POSIX needs the directory flushed.
export const syncsDirectories = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32';

// Windows mode bits are synthesized from the read-only attribute and say nothing about access.
export function privateMode(stat: Stats, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || (stat.mode & 0o077) === 0;
}
