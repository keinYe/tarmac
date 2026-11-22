import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readdir, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePayload, readPayload, deliverHook, runHook, findAgentAncestor, recordFailure, normalizeHookPayload } from './hook.ts';
import { LIMITS, VERSION } from '../../protocol/src/index.ts';
import type { HookEnvelope } from '../../protocol/src/index.ts';

const root = path.resolve('.tmp/app-m0-validation');
const payload = { session_id: 'agent-session', hook_event_name: 'UserPromptSubmit', prompt: '秘密不会写入失败标记' };
const event: HookEnvelope = { eventId: 'event-1', sessionId: 'pty-1', instanceId: 'instance-1', provider: 'codex', payload };
async function directory(): Promise<string> { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'hook-')); }

async function fakeDaemon(dir: string, reply: (frame: Record<string, unknown>, socket: net.Socket) => void) {
  const socketPath = path.join(dir, 'd.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index >= 0) reply(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>, socket);
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { socketPath, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('hook payload validates shape and preserves unknown events for daemon diagnostics', () => {
  assert.deepEqual(parsePayload(Buffer.from(JSON.stringify(payload))), payload);
  assert.equal(parsePayload(Buffer.from(JSON.stringify({ ...payload, hook_event_name: 'FutureEvent' }))).hook_event_name, 'FutureEvent');
  for (const value of ['[]', '{}', 'null', '{', '{"session_id":"a","hook_event_name":1}']) {
    assert.throws(() => parsePayload(Buffer.from(value)));
  }
});

test('stdin cap is enforced before EOF and timeout is bounded', async () => {
  const stream = new PassThrough();
  const result = readPayload(stream, 1000);
  stream.write(Buffer.alloc(LIMITS.hookBytes));
  stream.write(Buffer.from('x'));
  await assert.rejects(result, /invalid-payload/);
  assert.equal(stream.readableEnded, false);
  stream.destroy();
  const stalled = new PassThrough();
  await assert.rejects(readPayload(stalled, 15), /timeout/);
  stalled.destroy();
});

test('agent identity only uses matching ancestors, not hook shell or sibling processes', () => {
  const entries = [
    { pid: 10, ppid: 8, command: 'sh' }, { pid: 8, ppid: 2, command: '/usr/bin/codex' },
    { pid: 7, ppid: 2, command: 'claude' }, { pid: 2, ppid: 1, command: 'zsh' },
  ];
  assert.equal(findAgentAncestor('codex', entries, 10), 8);
  assert.equal(findAgentAncestor('claude', entries, 10), undefined);
  assert.equal(findAgentAncestor('codex', [{ pid: 4, ppid: 4, command: 'node' }], 4), undefined);
});

test('Kimi hook ancestry uses the executable when its process title is truncated', () => {
  const entries = [{ pid: 10, ppid: 8, command: 'sh' },
    { pid: 8, ppid: 1, command: 'kimi-cod', executable: '/home/user/.kimi-code/bin/kimi' }];
  assert.equal(findAgentAncestor('kimi', entries, 10), 8);
  assert.equal(findAgentAncestor('codex', entries, 10), undefined);
  assert.equal(findAgentAncestor('kimi', [{ ...entries[1], executable: '/usr/bin/node' }], 8), undefined);
});

test('delivery retries transport failure with the same event id and accepts only positive acknowledgement', async () => {
  const dir = await directory();
  const ids: unknown[] = [];
  const daemon = await fakeDaemon(dir, (frame, socket) => {
    ids.push((frame.event as HookEnvelope).eventId);
    if (ids.length === 1) socket.destroy();
    else socket.write(JSON.stringify({ v: VERSION, type: 'result', id: frame.id, ok: true }) + '\n');
  });
  try {
    assert.deepEqual(await deliverHook(daemon.socketPath, event), { delivered: true, attempts: 2 });
    assert.deepEqual(ids, ['event-1', 'event-1']);
  } finally { await daemon.close(); await rm(dir, { recursive: true }); }
});

test('daemon persistence failure is not acknowledged as delivered', async () => {
  const dir = await directory();
  const daemon = await fakeDaemon(dir, (frame, socket) => socket.write(JSON.stringify({ v: VERSION, type: 'result', id: frame.id, ok: false, error: 'storage failed' }) + '\n'));
  try {
    assert.deepEqual(await deliverHook(daemon.socketPath, event), { delivered: false, attempts: 1, reason: 'rejected' });
  } finally { await daemon.close(); await rm(dir, { recursive: true }); }
});

test('unresponsive daemon observes total timeout budget and closes pending request', async () => {
  const dir = await directory();
  const daemon = await fakeDaemon(dir, () => {});
  const start = performance.now();
  try {
    const result = await deliverHook(daemon.socketPath, event, 60);
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(performance.now() - start < 400);
  } finally { await daemon.close(); await rm(dir, { recursive: true }); }
});

test('failure marker is private metadata and missing Tarmac environment performs no delivery', async () => {
  const dir = await directory();
  await chmod(dir, 0o700);
  const env = { TARMAC_HOOK_FAILURE_DIR: dir, TARMAC_SOCKET: path.join(dir, 'missing.sock'), TARMAC_SESSION_ID: 'pty', TARMAC_INSTANCE_ID: 'run' };
  try {
    const result = await runHook('codex', Readable.from([JSON.stringify(payload)]), env);
    assert.equal(result.delivered, false);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const marker = await readFile(path.join(dir, files[0]), 'utf8');
    assert.equal(marker.includes(payload.prompt), false);
    assert.equal(JSON.parse(marker).reason, 'unavailable');
    assert.equal(JSON.parse(marker).instanceId, 'run');
    const skipped = await runHook('codex', new PassThrough(), {});
    assert.deepEqual(skipped, { delivered: false, attempts: 0 });
    recordFailure({ TARMAC_HOOK_FAILURE_DIR: path.join(dir, 'absent') }, event, 'timeout');
    assert.equal((await readdir(dir)).length, 1);
  } finally { await rm(dir, { recursive: true }); }
});

test('CLI hook always emits a no-decision JSON object and exits zero even for invalid stdin', async () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  for (const input of [JSON.stringify({ ...payload, hook_event_name: 'Stop' }), 'not-json']) {
    const child = spawn(process.execPath, [main, 'hook', 'codex'], {
      env: { ...process.env, TARMAC_SOCKET: '', TARMAC_SESSION_ID: '', TARMAC_INSTANCE_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(output, '{}\n');
    assert.equal(errors, '');
  }
});

test('Kimi hooks never print JSON into model context and recognize native ancestors', async () => {
  assert.equal(findAgentAncestor('kimi', [{ pid: 10, ppid: 8, command: 'sh' }, { pid: 8, ppid: 1, command: 'kimi-code' }], 10), 8);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url)), 'hook', 'kimi'], {
    env: { ...process.env, TARMAC_SOCKET: '', TARMAC_SESSION_ID: '', TARMAC_INSTANCE_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => output += chunk);
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
  assert.equal((await once(child, 'close'))[0], 0);
  assert.equal(output, '');
});

test('statusLine forwards exact stdin and colored stdout when Tarmac is unavailable or payload invalid', async () => {
  const forward = `${JSON.stringify(process.execPath)} -e 'process.stdin.pipe(process.stdout)'`;
  for (const input of [JSON.stringify({ session_id: 's', transcript_path: '/session.jsonl', rate_limits: {} }), '\u001b[32mraw original bytes\u001b[0m']) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url)), 'statusline', 'claude', '--forward', forward], {
      env: { ...process.env, TARMAC_SOCKET: '', TARMAC_SESSION_ID: '', TARMAC_INSTANCE_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.stdin.on('error', () => {}); child.stdin.end(input);
    assert.equal((await once(child, 'close'))[0], 0);
    assert.equal(output, input);
    assert.equal(errors, '');
  }
});

test('statusLine forward does not inherit Electron Node mode from the packaged CLI', async () => {
  const forward = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "unset")'`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url)), 'statusline', 'claude', '--forward', forward], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TARMAC_SOCKET: '', TARMAC_SESSION_ID: '', TARMAC_INSTANCE_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => output += chunk);
  child.stdin.on('error', () => {}); child.stdin.end('{}');
  assert.equal((await once(child, 'close'))[0], 0);
  assert.equal(output, 'unset');
});

test('hook envelopes carry invocation time before transport and payload waits', async () => {
  const dir = await directory();
  let received: HookEnvelope | undefined;
  const daemon = await fakeDaemon(dir, (frame, socket) => {
    received = frame.event as HookEnvelope;
    socket.write(JSON.stringify({ v: VERSION, type: 'result', id: frame.id, ok: true }) + '\n');
  });
  const input = new PassThrough();
  try {
    const before = Date.now();
    const pending = runHook('claude', input, { TARMAC_SOCKET: daemon.socketPath, TARMAC_SESSION_ID: 'pty', TARMAC_INSTANCE_ID: 'run' });
    await new Promise(resolve => setTimeout(resolve, 25));
    const after = Date.now();
    input.end(JSON.stringify(payload));
    assert.equal((await pending).delivered, true);
    assert.ok(received?.hookStartedAt && received.hookStartedAt >= before && received.hookStartedAt < after);
  } finally { await daemon.close(); await rm(dir, { recursive: true }); }
});

test('Kimi 2.6 native content parts, numeric turns and tool_call_id are normalized on the wire', async () => {
  const dir = await directory();
  const events: HookEnvelope[] = [];
  const daemon = await fakeDaemon(dir, (frame, socket) => {
    events.push(frame.event as HookEnvelope);
    socket.write(JSON.stringify({ v: VERSION, type: 'result', id: frame.id, ok: true }) + '\n');
  });
  const env = { TARMAC_SOCKET: daemon.socketPath, TARMAC_SESSION_ID: 'pty', TARMAC_INSTANCE_ID: 'run' };
  try {
    // Shapes from Kimi 2.6.1 AgentExternalHooksService and matchHooks; not a model call recording.
    for (const p of [
      { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: [{ type: 'text', text: 'hello\n世界' }, { type: 'image', data: 'not-history' }] },
      { session_id: 's', hook_event_name: 'TurnStarted', turn_id: 3, origin_kind: 'user' },
      { session_id: 's', hook_event_name: 'PreToolUse', tool_call_id: 'call-1', tool_name: 'Shell' },
    ]) assert.equal((await runHook('kimi', Readable.from([JSON.stringify(p)]), env)).delivered, true);
    assert.equal(events[0].payload.prompt, 'hello\n世界 [附件]');
    assert.equal(events[1].payload.turn_id, '3');
    assert.equal(events[2].payload.tool_use_id, 'call-1');
  } finally { await daemon.close(); await rm(dir, { recursive: true }); }
});

test('Kimi normalization rejects malformed text, invalid turns and conflicting tool identities', () => {
  for (const extra of [{ prompt: [{ type: 'text', text: 42 }] }, { prompt: [null] },
    { turn_id: -1 }, { turn_id: 1.5 }, { tool_call_id: 'a', tool_use_id: 'b' }]) {
    assert.throws(() => normalizeHookPayload('kimi', { ...payload, ...extra }), /invalid-payload/);
  }
  assert.equal(normalizeHookPayload('claude', payload), payload);
  assert.equal(normalizeHookPayload('codex', payload), payload);
  assert.equal(normalizeHookPayload('kimi', payload).prompt, payload.prompt);
});

test('Antigravity protojson camelCase payload and toolCall are normalized on the wire; stepIdx is not a turn', async () => {
  const dir = await directory();
  const events: HookEnvelope[] = [];
  const daemon = await fakeDaemon(dir, (frame, socket) => {
    events.push(frame.event as HookEnvelope);
    socket.write(JSON.stringify({ v: VERSION, type: 'result', id: frame.id, ok: true }) + '\n');
  });
  const env = { TARMAC_SOCKET: daemon.socketPath, TARMAC_SESSION_ID: 'pty', TARMAC_INSTANCE_ID: 'run' };
  try {
    const p1 = {
      conversationId: 'agy-conv-1',
      hookEventName: 'PreInvocation',
      lastUserInput: 'fix bug in agy',
      invocationNum: 0,
      transcriptPath: '/brain/agy-conv-1/.system_generated/logs/transcript_full.jsonl',
    };
    const p2 = {
      conversationId: 'agy-conv-1',
      hookEventName: 'PreToolUse',
      stepIdx: 5,
      toolCall: { id: 'call-99', name: 'run_command' },
    };
    assert.throws(() => parsePayload(Buffer.from(JSON.stringify(p1))), /invalid-payload/);
    assert.equal((await runHook('agy', Readable.from([JSON.stringify(p1)]), env)).delivered, true);
    assert.equal((await runHook('agy', Readable.from([JSON.stringify(p2)]), env)).delivered, true);
    assert.equal(events[0].payload.session_id, 'agy-conv-1');
    assert.equal(events[0].payload.hook_event_name, 'PreInvocation');
    assert.equal(events[0].payload.prompt, 'fix bug in agy');
    assert.equal(events[0].payload.transcript_path, '/brain/agy-conv-1/.system_generated/logs/transcript_full.jsonl');
    assert.equal(events[1].payload.turn_id, undefined);
    assert.equal(events[1].payload.tool_use_id, 'call-99');
    assert.equal(events[1].payload.tool_name, 'run_command');
  } finally { await daemon.close(); await rm(dir, { recursive: true }); }
});
