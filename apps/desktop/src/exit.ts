import type { Client } from '../../../packages/protocol/src/client.ts';
import type { DesktopExitResult } from '../../../packages/protocol/src/index.ts';

// The daemon makes the final shared-window decision after the dialog as well.
export async function exitDesktop(connection: Pick<Client, 'request' | 'waitForDisconnect'>,
  confirm: () => Promise<boolean>, commit: () => void): Promise<boolean> {
  let result = await connection.request<DesktopExitResult>({ type: 'desktop-exit' });
  if (result === 'confirmation-required') {
    if (!await confirm()) return false;
    result = await connection.request<DesktopExitResult>({ type: 'desktop-exit', confirmed: true });
  }
  if (result !== 'detached' && result !== 'shutdown') throw new Error('invalid desktop exit response');
  commit();
  if (result === 'shutdown') await connection.waitForDisconnect();
  return true;
}
