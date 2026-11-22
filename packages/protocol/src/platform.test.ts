import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDir, endpointPath, readEndpoint, sameToken, newToken, ownedByCurrentUser, privateMode, syncsDirectories, tokenRequired, writeToken, TOKEN_FILE } from './platform.ts';
import { defaultShell } from './shell.ts';

const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');

test('Windows endpoints are per user and data directory, independent of spelling', () => {
  const pipe = endpointPath('C:\\Users\\Me\\AppData\\Roaming\\Tarmac\\m0', 'win32', 'Me');
  assert.match(pipe, /^\\\\\.\\pipe\\tarmac-[0-9a-f]{32}$/);
  assert.equal(endpointPath('c:/users/me/appdata/roaming/tarmac/m0/', 'win32', 'me'), pipe);
  assert.notEqual(endpointPath('C:\\Users\\Me\\AppData\\Roaming\\Tarmac\\m0', 'win32', 'other'), pipe);
  assert.notEqual(endpointPath('C:\\Users\\Me\\AppData\\Roaming\\Tarmac\\m1', 'win32', 'Me'), pipe);
});

test('the default daemon data directory is Electron userData for tarmac-app, then m0', () => {
  assert.equal(defaultDataDir('linux', {}, '/home/me'), '/home/me/.config/tarmac-app/m0');
  assert.equal(defaultDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/me'), '/xdg/tarmac-app/m0');
  assert.equal(defaultDataDir('linux', { XDG_CONFIG_HOME: 'relative' }, '/home/me'), '/home/me/.config/tarmac-app/m0');
  assert.equal(defaultDataDir('darwin', {}, '/Users/me'), '/Users/me/Library/Application Support/tarmac-app/m0');
  assert.equal(defaultDataDir('win32', { APPDATA: 'C:\\Users\\Me\\AppData\\Roaming' }, 'C:\\Users\\Me'), 'C:\\Users\\Me\\AppData\\Roaming\\tarmac-app\\m0');
});

test('POSIX endpoints stay the data directory socket with the sockaddr length limit', () => {
  assert.equal(endpointPath('/home/me/.config/tarmac-app/m0', 'linux'), '/home/me/.config/tarmac-app/m0/daemon.sock');
  assert.throws(() => endpointPath('/' + 'x'.repeat(100), 'linux'), /at most 100 bytes/);
});

test('only Windows clients read and send the daemon token', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'token-'));
  try {
    assert.equal(readEndpoint(dir, 'win32').token, undefined, 'a missing token is retried, not invented');
    const token = newToken();
    await writeToken(dir, token);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, TOKEN_FILE))).mode & 0o777, 0o600);
    assert.equal(readEndpoint(dir, 'win32').token, token);
    assert.equal(readEndpoint(dir, 'linux').token, undefined);
    await writeFile(path.join(dir, TOKEN_FILE), 'not-a-token\n');
    assert.equal(readEndpoint(dir, 'win32').token, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.equal(tokenRequired('win32'), true);
  assert.equal(tokenRequired('linux'), false);
  assert.equal(tokenRequired('darwin'), false);
});

test('token comparison rejects wrong lengths and types', () => {
  const token = newToken();
  assert.equal(sameToken(token, token), true);
  assert.equal(sameToken(token, newToken()), false);
  assert.equal(sameToken(token, token.slice(1)), false);
  assert.equal(sameToken(token, 42), false);
});

test('directories are fsynced only on POSIX', () => {
  assert.equal(syncsDirectories('win32'), false);
  assert.equal(syncsDirectories('linux'), true);
  assert.equal(syncsDirectories('darwin'), true);
});

test('Windows ownership relies on the profile ACL, POSIX keeps uid and mode checks', async () => {
  const fake = { uid: 12345, mode: 0o40777 } as unknown as import('node:fs').Stats;
  assert.equal(ownedByCurrentUser(fake, 'win32'), true);
  assert.equal(privateMode(fake, 'win32'), true);
  assert.equal(privateMode(fake, 'linux'), false);
  assert.equal(privateMode({ mode: 0o40700 } as unknown as import('node:fs').Stats, 'linux'), true);
  if (typeof process.getuid === 'function') {
    assert.equal(ownedByCurrentUser(fake, 'linux'), process.getuid() === 12345);
    assert.equal(ownedByCurrentUser(await stat(base), 'linux'), true);
  }
});

test('default shell and its arguments are chosen together per platform', () => {
  assert.deepEqual(defaultShell({ SHELL: '/bin/zsh' }, 'linux'), { command: '/bin/zsh', args: ['-l'] });
  assert.deepEqual(defaultShell({}, 'darwin'), { command: '/bin/sh', args: ['-l'] });
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const bundled = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const env = { Path: 'relative;C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32', SystemRoot: 'C:\\Windows' };
  const withPwsh = defaultShell(env, 'win32', file => file === pwsh || file === bundled);
  assert.equal(withPwsh.command, pwsh);
  assert.deepEqual(withPwsh.args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command']);
  assert.match(withPwsh.args[3], /OutputEncoding/);
  assert.equal(withPwsh.args.includes('-l'), false);
  assert.equal(defaultShell(env, 'win32', file => file === bundled).command, bundled);
  assert.deepEqual(defaultShell({ ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32', () => false),
    { command: 'C:\\Windows\\System32\\cmd.exe', args: [] });
});
