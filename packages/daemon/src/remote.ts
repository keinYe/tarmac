import type headless from '@xterm/headless';
import type { RemoteKey } from '../../protocol/src/index.ts';

// Pure parts of external control (`tarmac ctl`): what a screen read returns and which bytes a
// text or key request writes. Contract in docs/tarmac-ctl.md.

type Terminal = InstanceType<typeof headless.Terminal>;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Normal buffer: up to `lines` scrollback rows plus the whole viewport, exactly what
// `capture-pane -p -S -N` returns (the viewport is never cut, even when its bottom is blank).
// Alternate screen: the viewport alone, since the scrollback holds what was there before the
// full-screen program. join re-joins soft-wrapped rows (`-J`).
export function screenText(terminal: Terminal, lines: number, join: boolean): { text: string; alternate: boolean } {
  const buffer = terminal.buffer.active;
  const alternate = buffer.type === 'alternate';
  const end = buffer.baseY + terminal.rows;
  const start = alternate ? buffer.baseY : Math.max(0, buffer.baseY - lines);
  const rows: string[] = [];
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // A row continued by the next keeps its trailing cells: they are part of the logical line.
    const continued = join && y + 1 < end && buffer.getLine(y + 1)?.isWrapped === true;
    const text = line.translateToString(!continued);
    if (join && line.isWrapped && rows.length) rows[rows.length - 1] += text;
    else rows.push(text);
  }
  return { text: rows.map(row => row.replace(/ +$/, '')).join('\n'), alternate };
}

// Bracketed paste (DECSET 2004) wraps the text; an end marker inside it would close the paste early.
export function pasteBytes(text: string, bracketed: boolean): string {
  return bracketed ? PASTE_START + text.replaceAll(PASTE_END, '') + PASTE_END : text;
}

// Cursor keys follow DECCKM like a real terminal: application mode sends SS3 sequences.
export function keyBytes(keys: readonly RemoteKey[], applicationCursor: boolean): string {
  return keys.map(key => key === 'Enter' ? '\r' : key === 'Escape' ? '\x1b'
    : `\x1b${applicationCursor ? 'O' : '['}${key === 'Up' ? 'A' : 'B'}`).join('');
}
