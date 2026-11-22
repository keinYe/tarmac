// `tarmac bridge` as a remote host runs it, for tests that go through a fake ssh: the bundled CLI
// reads its version from dist/, which the test suite does not build.
// Usage: bridge-fixture.ts <data-dir> <version>
import { runBridge } from '../src/bridge.ts';

await runBridge({ version: process.argv[3], dataDir: process.argv[2], stdin: process.stdin, stdout: process.stdout,
  startDaemon: () => { throw new Error('daemon not running'); } });
process.stdout.write('', () => process.exit(0));
