import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { fingerprintOf } from './first-connect.ts';

// A local SSH server for tests and the desktop smoke: password login, public keys from
// <home>/.ssh/authorized_keys, and exec runs the command with sh under that home, as sshd would.
// The real ssh client talks to it, so everything from ssh onwards is the everyday path.

const { Server, utils } = ssh2;

export interface TestSshServer { port: number; fingerprint: string; close(): void }

export async function startTestSshServer(options: { user: string; password: string; home: string }): Promise<TestSshServer> {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(hostKey.public);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('test host key');
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    client.on('authentication', async ctx => {
      if (ctx.username !== options.user) return ctx.reject();
      if (ctx.method === 'password') return ctx.password === options.password ? ctx.accept() : ctx.reject();
      if (ctx.method === 'publickey') {
        const lines = await readFile(`${options.home}/.ssh/authorized_keys`, 'utf8').catch(() => '');
        const allowed = lines.split('\n').filter(Boolean).map(line => utils.parseKey(line)).find(key =>
          !(key instanceof Error) && !Array.isArray(key) && key.getPublicSSH().equals(ctx.key.data));
        if (!allowed || allowed instanceof Error || Array.isArray(allowed)) return ctx.reject();
        if (ctx.signature && allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
        return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
      const stream = acceptExec();
      const child = spawn('/bin/sh', ['-c', info.command], { cwd: options.home, env: { ...process.env, HOME: options.home } });
      stream.pipe(child.stdin);
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream.stderr, { end: false });
      child.once('close', code => { stream.exit(code ?? 1); stream.end(); });
      stream.once('close', () => child.kill());
    })));
    client.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, fingerprint: fingerprintOf(parsed.getPublicSSH()), close: () => server.close() };
}
