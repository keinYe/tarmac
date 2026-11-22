import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2, { type ConnectConfig } from 'ssh2';

// ssh2 is CommonJS; its named exports are not visible to ESM in Node.
const { Client: SshClient, utils } = ssh2;
type SshClient = InstanceType<typeof SshClient>;
import type { HostConfig, SshFiles } from './remote.ts';

// First connection to a host (docs/app-remote-spec.md): confirm its host key, log in once with a
// password and append Tarmac's public key to its authorized_keys. Everyday connections then use
// the system ssh with that key. The password lives only in the arguments of deploy().

type Target = Pick<HostConfig, 'address' | 'user' | 'port'>;
export interface HostKey { type: string; blob: Buffer; fingerprint: string }
export interface Probe { key: HostKey; status: 'unknown' | 'match' | 'changed'; previous: string[] }

export const fingerprintOf = (blob: Buffer): string => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
function hostKey(blob: Buffer): HostKey {
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  return { type: blob.subarray(4, 4 + length).toString('latin1'), blob, fingerprint: fingerprintOf(blob) };
}
// The name ssh looks up in known_hosts: a non-default port is written [address]:port.
export const knownName = (target: Target): string => target.port && target.port !== 22 ? `[${target.address}]:${target.port}` : target.address;
const userOf = (target: Target): string => target.user || os.userInfo().username;

async function readLines(file: string): Promise<string[]> {
  try { return (await readFile(file, 'utf8')).split('\n'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
// Plain entries only; hashed (|1|) and @marker lines are left to ssh itself.
async function knownKeys(file: string, name: string): Promise<HostKey[]> {
  const keys: HostKey[] = [];
  for (const line of await readLines(file)) {
    const [names, type, data] = line.trim().split(/\s+/);
    if (!names || names.startsWith('#') || names.startsWith('@') || !type || !data) continue;
    if (!names.split(',').includes(name)) continue;
    const key = hostKey(Buffer.from(data, 'base64'));
    if (key.type === type) keys.push(key);
  }
  return keys;
}

function friendly(error: Error, target: Target): Error {
  if (/ENOTFOUND|EAI_AGAIN/.test(error.message)) return new Error(`无法解析 ${target.address}：首次连接需要填写 IP 或主机名，不支持 ~/.ssh/config 里的别名`);
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Timed out/i.test(error.message)) return new Error(`无法连接 ${target.address}：${error.message}`);
  if (/authentication methods failed/i.test(error.message)) return new Error('密码不正确，或这台主机不允许密码登录');
  return error;
}

function connect(config: ConnectConfig, target: Target): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.once('ready', () => resolve(client));
    client.once('error', error => { client.end(); reject(friendly(error, target)); });
    client.connect({ host: target.address, port: target.port ?? 22, username: userOf(target), readyTimeout: 10_000, ...config });
  });
}

// Reads the host key without logging in: the verifier refuses it, which ends the handshake.
export async function probeHost(target: Target, files: SshFiles): Promise<Probe> {
  let seen: HostKey | undefined;
  try {
    const client = await connect({ hostVerifier: (blob: Buffer) => { seen = hostKey(blob); return false; } }, target);
    client.end();
  } catch (error) { if (!seen) throw error; }
  if (!seen) throw new Error('没有收到主机公钥');
  const key = seen;
  const recorded = [...await knownKeys(files.knownHosts, knownName(target)), ...await knownKeys(files.userKnownHosts, knownName(target))];
  if (recorded.some(item => item.type === key.type && item.blob.equals(key.blob))) return { key, status: 'match', previous: [] };
  const previous = recorded.filter(item => item.type === key.type).map(item => item.fingerprint);
  return { key, status: previous.length ? 'changed' : 'unknown', previous };
}

async function replaceFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

// Replaces whatever tarmac_known_hosts held for this host; the user's known_hosts is not touched.
export async function trustHost(target: Target, key: HostKey, files: SshFiles): Promise<void> {
  const name = knownName(target);
  const kept = (await readLines(files.knownHosts)).filter(line => line.trim() && !line.trim().split(/\s+/)[0].split(',').includes(name));
  await replaceFile(files.knownHosts, [...kept, `${name} ${key.type} ${key.blob.toString('base64')}`].join('\n') + '\n');
}

// The comment marks Tarmac's line without naming this machine: agents on the host can read the file.
// Earlier builds wrote `tarmac-app@<machine>`; such lines are still recognized and replaced.
export const KEY_COMMENT = 'tarmac-app';
const PUBLIC_LINE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2} tarmac-app(?:@[A-Za-z0-9._-]+)?$/;
const keyOf = (line: string): string => {
  if (!PUBLIC_LINE.test(line)) throw new Error('invalid public key line');
  return line.split(' ').slice(0, 2).join(' ');
};
// The line as it goes into authorized_keys.
export const authorizedLine = (line: string): string => `${keyOf(line)} ${KEY_COMMENT}`;

// Creates the key pair once; an existing private key is reused and never overwritten.
export async function ensureKey(files: SshFiles): Promise<string> {
  let privateKey: string | undefined;
  try { privateKey = await readFile(files.key, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!privateKey) {
    const pair = utils.generateKeyPairSync('ed25519', { comment: KEY_COMMENT });
    await mkdir(path.dirname(files.key), { recursive: true, mode: 0o700 });
    await writeFile(files.key, pair.private, { mode: 0o600, flag: 'wx' });
    await writeFile(files.publicKey, `${pair.public.trim()}\n`, { mode: 0o644 });
    return pair.public.trim();
  }
  const saved = (await readLines(files.publicKey)).map(line => line.trim()).find(Boolean);
  if (saved) {
    if (!PUBLIC_LINE.test(saved)) throw new Error(`${files.publicKey} 不是 Tarmac 生成的公钥`);
    return saved;
  }
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== 'ssh-ed25519') throw new Error(`${files.key} 不是可用的 ed25519 私钥`);
  const line = `ssh-ed25519 ${parsed.getPublicSSH().toString('base64')} ${KEY_COMMENT}`;
  await writeFile(files.publicKey, line + '\n', { mode: 0o644 });
  return line;
}

// Rewrites authorized_keys without Tarmac's lines for this key (either comment form), keeping every
// other line; the file keeps its inode and mode. Shared by deploy (only when an old form is present)
// and revoke.
const dropOwnLines = ['umask 077', 'tmp="$f.tarmac-$$"', `awk -v p="$key ${KEY_COMMENT}" 'index($0, p) != 1' "$f" > "$tmp" || { rm -f "$tmp"; exit 1; }`,
  'cat "$tmp" > "$f" || { rm -f "$tmp"; exit 1; }', 'rm -f "$tmp"'];

// Run with sh on the remote host, reading the script from stdin so no login shell parses it.
export function deployScript(line: string): string {
  return [`key='${keyOf(line)}'`, `line="$key ${KEY_COMMENT}"`, 'f="$HOME/.ssh/authorized_keys"',
    '[ -d "$HOME/.ssh" ] || mkdir -m 700 "$HOME/.ssh" || exit 1',
    // An older line of this key that names the machine is replaced, so the host no longer shows it.
    `if [ -f "$f" ] && awk -v p="$key ${KEY_COMMENT}@" 'index($0, p) == 1 { found = 1 } END { exit !found }' "$f"; then`,
    ...dropOwnLines.map(command => '  ' + command), 'fi',
    'if [ -f "$f" ] && grep -qxF "$line" "$f"; then exit 0; fi',
    // A last line without a newline would merge with ours.
    'if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf \'\\n\' >> "$f" || exit 1; fi',
    '( umask 077; printf \'%s\\n\' "$line" >> "$f" ) || exit 1', ''].join('\n');
}
export function revokeScript(line: string): string {
  return [`key='${keyOf(line)}'`, 'f="$HOME/.ssh/authorized_keys"', '[ -f "$f" ] || exit 0',
    `awk -v p="$key ${KEY_COMMENT}" 'index($0, p) == 1 { found = 1 } END { exit !found }' "$f" || exit 0`, ...dropOwnLines, ''].join('\n');
}

function run(client: SshClient, command: string, input: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stderr = '';
      stream.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
      stream.on('data', () => {});
      stream.once('close', (code: number | null) => resolve({ code, stderr }));
      stream.end(input);
    });
  });
}

// Logs in once with the password, only to a host whose key was confirmed, and appends Tarmac's key.
export async function deployKey(target: Target, password: string, files: SshFiles): Promise<string> {
  // A key the user's own known_hosts already holds counts as confirmed, as it does for ssh itself.
  const trusted = [...await knownKeys(files.knownHosts, knownName(target)), ...await knownKeys(files.userKnownHosts, knownName(target))];
  if (!trusted.length) throw new Error('请先确认这台主机的指纹');
  const line = authorizedLine(await ensureKey(files));
  const client = await connect({ password, tryKeyboard: false,
    hostVerifier: (blob: Buffer) => trusted.some(item => item.blob.equals(blob)) }, target);
  try {
    const result = await run(client, '/bin/sh -s', deployScript(line));
    if (result.code !== 0) throw new Error(`写入 authorized_keys 失败：${result.stderr.trim() || `退出码 ${result.code}`}`);
  } finally { client.end(); }
  return line;
}

export async function publicKeyLine(files: SshFiles): Promise<string | undefined> {
  const saved = (await readLines(files.publicKey)).map(line => line.trim()).find(Boolean);
  return saved && PUBLIC_LINE.test(saved) ? saved : undefined;
}
