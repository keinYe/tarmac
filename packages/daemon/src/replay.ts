import headless from '@xterm/headless';
import type { IBuffer } from '@xterm/headless';
import { LIMITS } from '../../protocol/src/index.ts';

type Terminal = InstanceType<typeof headless.Terminal>;

export interface ReplayBase {
  seq: number;
  cols: number;
  rows: number;
  // Bytes a fresh terminal of cols x rows must parse to reach the base state.
  data: string;
  exact: boolean;
  reason?: string;
}
export type ReplayRecord =
  | { seq: number; kind: 'output'; data: Buffer }
  | { seq: number; kind: 'resize'; cols: number; rows: number };
export type ReplayFrame =
  | { kind: 'output'; first: number; seq: number; data: Buffer }
  | { kind: 'resize'; seq: number; cols: number; rows: number };

// Ordered output/resize records after a base. Records are contiguous:
// records[i].seq === base.seq + 1 + i.
export class ReplayLog {
  private current: ReplayBase;
  private records: ReplayRecord[] = [];
  private size = 0;

  constructor(base: ReplayBase) { this.current = base; }

  get base(): ReplayBase { return this.current; }
  get bytes(): number { return this.size; }
  get end(): number { return this.current.seq + this.records.length; }

  append(record: ReplayRecord): void {
    if (record.seq !== this.end + 1) throw new Error('replay log sequence gap');
    this.records.push(record);
    if (record.kind === 'output') this.size += record.data.length;
  }

  through(seq: number): ReplayRecord[] { return this.records.slice(0, seq - this.current.seq); }

  rebase(base: ReplayBase): void {
    const dropped = this.records.splice(0, base.seq - this.current.seq);
    for (const record of dropped) if (record.kind === 'output') this.size -= record.data.length;
    this.current = base;
  }

  // Frames after `after`, merging consecutive output records up to `limit`
  // bytes per frame. Undefined means `after` precedes the base and is gone.
  // limit caps one merged output frame, total the output bytes of the whole call (at least one
  // frame is returned). Without total a subscriber far behind would get its entire backlog at once.
  read(after: number, limit: number, maxFrames: number, total = Infinity): ReplayFrame[] | undefined {
    if (after < this.current.seq || after > this.end) return undefined;
    const frames: ReplayFrame[] = [];
    let index = after - this.current.seq;
    let returned = 0;
    while (index < this.records.length && frames.length < maxFrames && returned < total) {
      const record = this.records[index];
      if (record.kind === 'resize') { frames.push({ ...record }); index++; continue; }
      const parts = [record.data];
      let bytes = record.data.length;
      let last = record.seq;
      index++;
      while (index < this.records.length) {
        const next = this.records[index];
        if (next.kind !== 'output' || bytes + next.data.length > limit) break;
        parts.push(next.data); bytes += next.data.length; last = next.seq; index++;
      }
      frames.push({ kind: 'output', first: record.seq, seq: last, data: parts.length === 1 ? parts[0] : Buffer.concat(parts) });
      returned += bytes;
    }
    return frames;
  }
}

export function createTerminal(cols: number, rows: number): Terminal {
  return new headless.Terminal({ cols, rows, scrollback: LIMITS.scrollback, allowProposedApi: true });
}
function write(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise(resolve => terminal.write(data, resolve));
}
export async function replayInto(terminal: Terminal, base: Pick<ReplayBase, 'data'>, records: readonly ReplayRecord[]): Promise<void> {
  if (base.data) terminal.write(base.data);
  // xterm queues writes in order; only a resize has to wait for parsing to catch up.
  for (const record of records) {
    if (record.kind === 'output') terminal.write(record.data);
    else { await write(terminal, ''); terminal.resize(record.cols, record.rows); }
  }
  await write(terminal, '');
}

function bufferState(buffer: IBuffer): unknown {
  return {
    cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY, length: buffer.length,
    lines: Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row)!;
      const cells: unknown[] = [];
      for (let column = 0; column < line.length; column++) {
        const cell = line.getCell(column)!;
        cells.push([cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
          cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isDim(),
          cell.isUnderline(), cell.isBlink(), cell.isInverse(), cell.isInvisible(),
          cell.isStrikethrough(), cell.isOverline()]);
      }
      return [line.isWrapped, cells];
    }),
  };
}

// Everything observable through the public API, for both screen buffers.
export function terminalState(terminal: Terminal): string {
  return JSON.stringify({
    cols: terminal.cols, rows: terminal.rows, modes: { ...terminal.modes }, active: terminal.buffer.active.type,
    normal: bufferState(terminal.buffer.normal), alternate: bufferState(terminal.buffer.alternate),
  });
}

// Each section makes one class of state that serialize does not export visible
// in the buffer, so a restored terminal that lacks it diverges from the reference.
export function probeSections(cols: number, rows: number): [string, string][] {
  return [
    ['画笔与字符集', 'P' + 'q\x0fq\x0eq\x0f\x1bNq\x1bOq'],
    ['DEC 保存光标', '\x1b8P'],
    ['SCO 保存光标', '\x1b[uP'],
    ['Tab 停靠点', '\r' + '\tT'.repeat(Math.ceil(cols / 2))],
    ['origin mode 与滚动区', '\x1b[HO' + '\n'.repeat(rows + 1) + 'S\x1b[H' + '\x1bM'.repeat(rows + 1) + 'R'],
    ['备用屏幕', '\x1b[?1049lA\x1b[?47lB'],
  ];
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

// Compares a serialize-based candidate base with an exact reference rebuilt
// from the previous base. Neither terminal is connected to any reply sink.
export async function verifyCheckpoint(base: ReplayBase, records: readonly ReplayRecord[], candidate: Omit<ReplayBase, 'exact' | 'reason'>): Promise<CheckResult> {
  const reference = createTerminal(base.cols, base.rows);
  const restored = createTerminal(candidate.cols, candidate.rows);
  try {
    await replayInto(reference, base, records);
    await replayInto(restored, candidate, []);
    if (terminalState(reference) !== terminalState(restored)) return { ok: false, reason: '恢复画面' };
    for (const [name, probe] of probeSections(candidate.cols, candidate.rows)) {
      await write(reference, probe);
      await write(restored, probe);
      if (terminalState(reference) !== terminalState(restored)) return { ok: false, reason: name };
    }
    return { ok: true };
  } finally { reference.dispose(); restored.dispose(); }
}
