import { acquireLease } from '../src/lease.ts';

try {
  const lease = await acquireLease(process.argv[2]);
  process.send?.({ type: 'acquired' });
  process.once('message', () => {
    void lease.release().then(() => process.disconnect?.()).catch(() => { process.exitCode = 1; process.disconnect?.(); });
  });
} catch {
  process.send?.({ type: 'refused' });
  process.disconnect?.();
}
