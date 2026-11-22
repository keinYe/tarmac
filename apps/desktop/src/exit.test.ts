import test from 'node:test';
import assert from 'node:assert/strict';
import { exitDesktop } from './exit.ts';
import type { Request, DesktopExitResult } from '../../../packages/protocol/src/index.ts';

function connection(results: DesktopExitResult[]) {
  const trace: unknown[] = [];
  return { trace, async request<T>(request: Request): Promise<T> { trace.push(request); return results.shift() as T; },
    async waitForDisconnect() { trace.push('disconnected'); } };
}

test('cancelling App exit leaves the desktop registered without committing shutdown', async () => {
  const c = connection(['confirmation-required']);
  assert.equal(await exitDesktop(c, async () => false, () => assert.fail('must not commit')), false);
  assert.deepEqual(c.trace, [{ type: 'desktop-exit' }]);
});

test('confirmed exit disables reconnect before awaiting shutdown, while other windows remain independent', async () => {
  const c = connection(['confirmation-required', 'shutdown']);
  assert.equal(await exitDesktop(c, async () => true, () => c.trace.push('commit')), true);
  assert.deepEqual(c.trace, [{ type: 'desktop-exit' }, { type: 'desktop-exit', confirmed: true }, 'commit', 'disconnected']);
  const shared = connection(['detached']);
  assert.equal(await exitDesktop(shared, async () => assert.fail('another window remains'), () => shared.trace.push('commit')), true);
  assert.deepEqual(shared.trace, [{ type: 'desktop-exit' }, 'commit']);
});

test('invalid exit replies never commit or silently close the App', async () => {
  const c = connection([]);
  await assert.rejects(exitDesktop(c, async () => true, () => assert.fail('must not commit')), /invalid desktop exit/);
});
