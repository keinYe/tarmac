// Fills the scrollback with dense truecolor cells, like a diff-heavy agent TUI, so a compacted
// replay base serializes to far more than one protocol frame. Usage: colorful.mjs <cols> <lines>
const cols = Number(process.argv[2] ?? 200);
const lines = Number(process.argv[3] ?? 200);
let out = '';
for (let y = 0; y < lines; y++) {
  for (let x = 0; x < cols - 1; x++) {
    out += `\x1b[38;2;${(x * 7 + y) % 256};${(x * 3) % 256};${y % 256};48;2;${y % 256};${(x + y) % 256};${(x * 5) % 256}m${String.fromCharCode(97 + ((x + y) % 26))}`;
  }
  out += '\x1b[0m\r\n';
  if (out.length > 1 << 20) { process.stdout.write(out); out = ''; }
}
process.stdout.write(out + 'COLORFUL-DONE\r\n');
process.stdin.on('data', data => process.stdout.write(`INPUT:${data.toString().trim()}\r\n`));
