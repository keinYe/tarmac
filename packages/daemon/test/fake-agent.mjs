// Deterministic local fixture. It never contacts an external service.
import readline from 'node:readline';
import { openSync, closeSync } from 'node:fs';
// The first argument names the process when no environment can be passed (`tarmac ctl create`).
process.title = process.env.TARMAC_TEST_PROVIDER ?? process.argv[2] ?? 'claude';
if (process.env.TARMAC_TEST_TRANSCRIPT) {
  const fd = openSync(process.env.TARMAC_TEST_TRANSCRIPT, 'r');
  process.on('exit', () => closeSync(fd));
}
process.stdout.write(`READY:${process.pid}\r\n`);
// After `hex`, stdin is raw and every chunk is reported as hex: tests see the exact bytes written.
let hex = false;
process.stdin.on('data', chunk => { if (hex) process.stdout.write(`HEX:${Buffer.from(chunk).toString('hex')}\r\n`); });
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', raw => {
  if (hex) return;
  // Like a line editor, a bracketed paste delivers its text without the markers.
  const line = raw.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
  if (line === 'hex') {
    hex = true;
    process.stdin.setRawMode?.(true);
    process.stdout.write('HEX-ON\r\n');
  } else if (line === 'paste on') {
    process.stdout.write('\x1b[?2004hPASTE-ON\r\n');
  } else if (line === 'appcursor on') {
    process.stdout.write('\x1b[?1hAPPCURSOR-ON\r\n');
  } else if (line.startsWith('flood ')) {
    process.stdout.write(('fixture-output-中文\r\n').repeat(Number(line.slice(6))));
  } else if (line === 'badseq') {
    // An unterminated OSC string longer than 1 MiB: the transport framer must
    // reject it instead of buffering an incomplete sequence without bound.
    process.stdout.write(Buffer.concat([Buffer.from('\x1b]'), Buffer.alloc(1100 * 1024, 0x78)]));
  } else if (line.startsWith('print ')) {
    // Raw screen text, e.g. an approval overlay for screen-recognition tests.
    process.stdout.write(`${line.slice(6)}\r\n`);
  } else if (line === 'query') {
    process.stdout.write('\x1b[6n');
  } else if (line === 'quit') {
    process.exit(7);
  } else process.stdout.write(`INPUT:${line}\r\n`);
});
process.on('SIGWINCH', () => process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`));
