import { Daemon } from './server.ts';

async function main(): Promise<void> {
  const index = process.argv.indexOf('--data-dir');
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: tarmacd --data-dir <absolute directory>');
  const daemon = new Daemon(process.argv[index + 1]);
  await daemon.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void daemon.stop().catch(() => { process.exitCode = 1; }); });
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'daemon failed'); process.exitCode = 1; });
