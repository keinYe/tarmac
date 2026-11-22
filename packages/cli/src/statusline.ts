import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { parsePayload, readInput, runHook } from './hook.ts';
import { LIMITS } from '../../protocol/src/index.ts';

// Explicit opt-in wrapper: stdout belongs entirely to the existing statusLine.
// The original command sees the original bytes, even if telemetry is invalid.
export async function statusline(input: NodeJS.ReadableStream, command: string,
  env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const bytes = await readInput(input, LIMITS.hookTimeoutMs);
  // The packaged CLI runs on the App's Electron in Node mode; the user's own command must not inherit that.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...forwardEnv } = env;
  const forward = new Promise<void>(resolve => {
    const child = spawn(command, { shell: true, env: forwardEnv, stdio: ['pipe', 'inherit', 'inherit'] });
    const timer = setTimeout(() => child.kill(), 2000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
  const report = (async () => {
    try {
      const payload = parsePayload(bytes, 'StatusLine');
      await runHook('claude', Readable.from([JSON.stringify(payload)]), env);
    } catch { /* StatusLine rendering is independent of telemetry. */ }
  })();
  await Promise.all([forward, report]);
}
