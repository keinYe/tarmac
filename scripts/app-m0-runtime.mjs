import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../packages/protocol/src/client.ts';
import { DAEMON_NODE_FLAGS } from '../packages/daemon/src/runtime.ts';
import { readEndpoint } from '../packages/protocol/src/platform.ts';

const root = path.resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const artifact = path.resolve(process.argv[2] ?? path.join(root, `dist/package/Tarmac-${process.platform}-${process.arch}`));
const binary = process.platform === 'darwin'
  ? path.join(artifact, 'Tarmac.app/Contents/MacOS/Tarmac')
  : path.join(artifact, windows ? 'Tarmac.exe' : 'Tarmac');
const resources = process.platform === 'darwin'
  ? path.join(artifact, 'Tarmac.app/Contents/Resources/app')
  : path.join(artifact, 'resources/app');
const base = path.join(root, '.tmp/app-m0-validation');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, 'rt-'));
const child = spawn(binary, [...DAEMON_NODE_FLAGS, path.join(resources, 'dist/daemon.cjs'), '--data-dir', directory], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
let client;
try {
  for (let attempts = 0; attempts < 100; attempts++) {
    let candidate;
    try {
      const endpoint = readEndpoint(directory);
      candidate = await Client.connect(endpoint.path, 200, endpoint.token);
      // The socket listens before the daemon has loaded its data; wait for a valid reply.
      await candidate.request({ type: 'list' }, 2000);
      client = candidate;
      break;
    } catch {
      candidate?.close();
      if (child.exitCode !== null || child.signalCode) throw new Error(`packaged daemon exited: ${errors}`);
      await delay(30);
    }
  }
  if (!client) throw new Error(`packaged daemon unavailable: ${errors}`);
  const events = [];
  client.on('event', event => events.push(event));
  const info = await client.request({ type: 'create', options: {
    ...(windows
      ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', "Write-Output 'PACKAGED-PTY-READY'; $line = [Console]::ReadLine(); Write-Output ('PACKAGED-INPUT:' + $line)"] }
      : { command: '/bin/sh', args: ['-c', 'printf "PACKAGED-PTY-READY\\n"; read line; printf "PACKAGED-INPUT:%s\\n" "$line"'] }),
    cwd: directory, cols: 80, rows: 24,
  } });
  const identity = { sessionId: info.sessionId, instanceId: info.instanceId };
  await client.request({ type: 'attach', ...identity });
  const snapshot = events.find(event => event.type === 'snapshot');
  if (!snapshot) throw new Error('no packaged snapshot');
  // Input is accepted only after the replay is acknowledged up to the attach-time log end.
  const replayed = () => Math.max(snapshot.seq, ...events.filter(event => event.type === 'output' || event.type === 'resize').map(event => event.seq));
  for (let attempts = 0; replayed() < snapshot.target; attempts++) {
    if (attempts === 100) throw new Error('packaged replay did not reach its target');
    await delay(30);
  }
  await client.request({ type: 'ack', ...identity, seq: replayed() });
  // A console reads Enter as carriage return.
  await client.request({ type: 'input', ...identity, data: windows ? 'native-addon-ok\r' : 'native-addon-ok\n' });
  for (let attempts = 0; attempts < 100; attempts++) {
    const text = events.filter(event => event.type === 'snapshot' || event.type === 'output')
      .map(event => Buffer.from(event.data, 'base64').toString()).join('');
    if (text.includes('PACKAGED-INPUT:native-addon-ok')) break;
    if (attempts === 99) throw new Error('packaged PTY did not process input');
    await delay(30);
  }
  await client.request({ type: 'shutdown' });
  const result = await ended;
  if (result.code !== 0) throw new Error(`packaged daemon did not exit cleanly: ${errors}`);
  console.log(JSON.stringify({ packagedRuntime: 'pass', checks: ['electron-node-runtime', 'native-pty', 'snapshot', 'input', 'shutdown'], artifact }));
} finally {
  client?.close();
  if (child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await ended; }
  await rm(directory, { recursive: true, force: true });
}
