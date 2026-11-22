// Measures the current daemon; historical M0 numbers remain in the budget document.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../packages/protocol/src/client.ts';
import { sampleProcess } from './app-m1-metrics.ts';
import { DAEMON_NODE_FLAGS } from '../packages/daemon/src/runtime.ts';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.tmp/app-m1-validation/baseline');
await mkdir(base, { recursive: true });
const report = path.join(base, `baseline-${Date.now()}.json`);
console.log(JSON.stringify({ report }));
const results = { status: 'running', measuredAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576) }, scenarios: [] };
for (const count of [0, 1, 8]) {
  const dir = await mkdtemp(path.join(base, 'b-'));
  const child = spawn(process.execPath, [...DAEMON_NODE_FLAGS, '--experimental-strip-types', path.join(root, 'packages/daemon/src/main.ts'), '--data-dir', dir],
    { stdio: ['ignore', 'ignore', 'inherit'], cwd: root });
  const ended = new Promise(resolve => child.once('exit', resolve));
  let client;
  let flood;
  try {
    for (let i = 0; i < 100; i++) {
      let candidate;
      try {
        candidate = await Client.connect(path.join(dir, 'daemon.sock'), 100);
        await candidate.request({ type: 'list' }, 500);
        client = candidate; break;
      } catch { candidate?.close(); await delay(50); }
    }
    if (!client) throw new Error('daemon did not start');
    const ready = new Set();
    client.on('event', event => {
      if (!['snapshot', 'output', 'resize'].includes(event.type)) return;
      void client.request({ type: 'ack', sessionId: event.sessionId, instanceId: event.instanceId, seq: event.seq })
        .then(() => ready.add(event.sessionId)).catch(() => {});
    });
    const sessions = [];
    for (let i = 0; i < count; i++) {
      const info = await client.request({ type: 'create', options: {
        command: process.execPath, args: [path.join(root, 'packages/daemon/test/fake-agent.mjs')], cwd: dir, cols: 100, rows: 30,
        env: { TARMAC_TEST_PROVIDER: 'shell' },
      } });
      sessions.push(info);
      await client.request({ type: 'attach', ...info });
    }
    for (let i = 0; ready.size < count; i++) {
      if (i === 100) throw new Error('sessions did not become ready');
      await delay(30);
    }
    flood = setInterval(() => {
      for (const info of sessions) void client.request({ type: 'input', ...info, data: 'flood 200\n' }).catch(() => {});
    }, 250);
    await delay(500);
    results.scenarios.push({ sessions: count, ...await sampleProcess(child.pid, 5000) });
    await writeFile(report, JSON.stringify(results, null, 2) + '\n');
    if (count === 8) {
      clearInterval(flood);
      flood = undefined;
      const closeAll = async entries => {
        await Promise.all(entries.map(info => client.request({ type: 'close', ...info })));
        for (let i = 0; i < 100; i++) {
          if ((await client.request({ type: 'list' })).every(info => !info.alive)) return;
          await delay(20);
        }
        throw new Error('session exit timeout');
      };
      await closeAll(sessions);
      await delay(200);
      const releasedFdCount = (await readdir(`/proc/${child.pid}/fd`)).length;
      results.releaseRounds = [];
      // Run beyond the first allocator warm-up instead of inferring a leak
      // or stability from only the first few RSS samples.
      for (let round = 0; round < 64; round++) {
        const entries = await Promise.all(Array.from({ length: 8 }, () => client.request({ type: 'create', options: {
          command: process.execPath, args: [path.join(root, 'packages/daemon/test/fake-agent.mjs')], cwd: dir, cols: 100, rows: 30,
          env: { TARMAC_TEST_PROVIDER: 'shell' },
        } })));
        await closeAll(entries);
        await delay(200);
        const openFds = (await readdir(`/proc/${child.pid}/fd`)).length;
        const sample = await sampleProcess(child.pid, 500);
        results.releaseRounds.push({ round: round + 1, openFds, releasedFdCount, ...sample });
        if (openFds > releasedFdCount || sample.rssMaxKb > 220 * 1024) results.status = 'fail';
        await writeFile(report, JSON.stringify(results, null, 2) + '\n');
        assert.ok(openFds <= releasedFdCount, 'PTY descriptors did not return to the released baseline');
        assert.ok(sample.rssMaxKb <= 220 * 1024, 'create/close cycle exceeds frozen daemon RSS budget');
        if ((round + 1) % 16 === 0) console.log(JSON.stringify({ releaseRounds: round + 1, openFds, rssMaxKb: sample.rssMaxKb }));
      }
    }
  } finally {
    if (flood) clearInterval(flood);
    await client?.request({ type: 'shutdown' }).catch(() => {});
    client?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await ended;
    await rm(dir, { recursive: true, force: true });
  }
}
for (const sample of results.scenarios) {
  const rssLimit = sample.sessions === 0 ? 120 : sample.sessions === 1 ? 140 : 220;
  assert.ok(sample.rssMaxKb <= rssLimit * 1024, 'daemon RSS exceeds frozen budget');
  if (sample.sessions) assert.ok(sample.cpuPercent <= (sample.sessions === 1 ? 12 : 20), 'daemon CPU exceeds corrected equivalent budget');
}
const idle = results.scenarios[0].rssMaxKb;
assert.ok((results.scenarios[2].rssMaxKb - idle) / 8 <= 8 * 1024, 'per-session RSS exceeds frozen budget');
assert.ok(results.releaseRounds.some((sample, index, rounds) => index >= 8 && sample.rssMaxKb <= rounds[index - 1].rssMaxKb), 'RSS kept increasing throughout all release rounds');
results.status = 'pass';
await writeFile(report, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ report, scenarios: results.scenarios, releaseRounds: results.releaseRounds.length,
  releaseRssMaxKb: Math.max(...results.releaseRounds.map(sample => sample.rssMaxKb)), releasedFdCount: results.releaseRounds[0].releasedFdCount }, null, 2));
