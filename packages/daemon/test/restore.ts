import headless from '@xterm/headless';
import { TerminalStream } from '../src/terminal.ts';
import type { ServerEvent } from '../../protocol/src/index.ts';

type Terminal = InstanceType<typeof headless.Terminal>;
type Snapshot = Extract<ServerEvent, { type: 'snapshot' }>;

export function write(terminal: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise(resolve => terminal.write(data, resolve));
}

export async function snapshotOf(stream: TerminalStream): Promise<Snapshot> {
  let frame: Snapshot | undefined;
  await stream.snapshot(value => { frame = value; });
  if (!frame) throw new Error('no snapshot');
  return frame;
}

// Applies frames after `after` the way the desktop client does; returns the last seq. It reads
// without a total budget: pacing is covered by snapshot-parts.test.ts, and a paced reader could
// be overtaken by a compaction finishing between its reads.
export async function applyFrames(terminal: Terminal, stream: TerminalStream, after: number): Promise<number> {
  let seq = after;
  for (;;) {
    const frames = stream.read(seq, Infinity, 4096);
    if (!frames) throw new Error('subscriber fell behind the replay base');
    if (!frames.length) return seq;
    for (const { event } of frames) {
      if (event.type === 'output') {
        if (event.first !== seq + 1) throw new Error('sequence gap');
        await write(terminal, Buffer.from(event.data, 'base64'));
      } else {
        if (event.seq !== seq + 1) throw new Error('sequence gap');
        terminal.resize(event.cols, event.rows);
      }
      seq = event.seq;
    }
  }
}

// A new subscriber: base frame plus the replayed log up to the current end.
export async function restore(stream: TerminalStream, onData?: (data: string) => void): Promise<{ terminal: Terminal; seq: number; snapshot: Snapshot }> {
  const snapshot = await snapshotOf(stream);
  const terminal = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 2000, allowProposedApi: true });
  if (onData) terminal.onData(onData);
  if (snapshot.data) await write(terminal, Buffer.from(snapshot.data, 'base64'));
  const seq = await applyFrames(terminal, stream, snapshot.seq);
  return { terminal, seq, snapshot };
}
