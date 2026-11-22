import type { Identity, ServerEvent } from '../../../packages/protocol/src/index.ts';

export interface StreamTerminal {
  cols: number;
  rows: number;
  write(data: Uint8Array, callback: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export class TerminalStream {
  private readonly callbacks: {
    create(cols: number, rows: number, identity: Identity): StreamTerminal;
    acknowledge(identity: Identity, seq: number, part?: number): Promise<void>;
    ready(value: boolean): void;
    fault(error: Error): void;
  };
  private identity: Identity | null = null;
  private terminal: StreamTerminal | null = null;
  private serial = Promise.resolve();
  private epoch = 0;
  private seq = -1;
  private target = -1;
  // Parts of a split replay base still to come; output records may only follow them.
  private parts = 0;
  private nextPart = 0;
  private ready = false;
  private failed = false;
  constructor(callbacks: {
    create(cols: number, rows: number, identity: Identity): StreamTerminal;
    acknowledge(identity: Identity, seq: number, part?: number): Promise<void>;
    ready(value: boolean): void;
    fault(error: Error): void;
  }) { this.callbacks = callbacks; }

  prepare(identity: Identity): void {
    this.epoch++;
    this.identity = identity;
    this.ready = false;
    this.failed = false;
    this.seq = -1;
    this.target = -1;
    this.parts = 0;
    this.nextPart = 0;
    this.callbacks.ready(false);
  }

  disconnect(): void {
    this.epoch++;
    this.ready = false;
    this.callbacks.ready(false);
  }

  acceptsInput(): boolean { return this.ready && !this.failed; }

  receive(event: Extract<ServerEvent, { type: 'snapshot' | 'snapshot-part' | 'output' | 'resize' }>): Promise<void> {
    const epoch = this.epoch;
    this.serial = this.serial.then(async () => {
      if (epoch !== this.epoch || this.failed || !this.identity
        || event.sessionId !== this.identity.sessionId || event.instanceId !== this.identity.instanceId) return;
      let part: number | undefined;
      if (event.type === 'snapshot') {
        if (!Number.isSafeInteger(event.target) || event.target < event.seq) throw new Error('回放基点缺少有效的目标序号');
        if (event.parts !== undefined && (!Number.isSafeInteger(event.parts) || event.parts < 2)) throw new Error('回放基点分片数无效');
        this.ready = false;
        this.callbacks.ready(false);
        this.terminal?.dispose();
        this.terminal = this.callbacks.create(event.cols, event.rows, { ...this.identity });
        // Replay starts from the base; input stays disabled until the log end at attach time.
        if (event.data) await this.write(event.data);
        if (epoch !== this.epoch) return;
        this.seq = event.seq;
        this.target = event.target;
        if (event.parts) { this.parts = event.parts; this.nextPart = 1; part = 0; }
      } else if (event.type === 'snapshot-part') {
        // Parts are written as they arrive: xterm keeps UTF-8 and escape parser state across writes.
        if (!this.terminal || !this.parts || event.part !== this.nextPart || event.seq !== this.seq) throw new Error('回放基点分片不连续，需要重新同步');
        await this.write(event.data);
        if (epoch !== this.epoch) return;
        part = this.nextPart++;
        if (this.nextPart === this.parts) this.parts = 0;
      } else {
        if (!this.terminal || this.seq < 0) throw new Error('收到回放基点之前的增量');
        if (this.parts) throw new Error('回放基点尚未接收完整');
        const first = event.type === 'output' ? event.first : event.seq;
        if (first !== this.seq + 1 || event.seq < first) throw new Error('终端输出序号不连续，需要重新同步');
        if (event.type === 'output') await this.write(event.data);
        else this.terminal.resize(event.cols, event.rows);
        if (epoch !== this.epoch) return;
        this.seq = event.seq;
      }
      await this.callbacks.acknowledge(this.identity, this.seq, part);
      if (epoch !== this.epoch || this.ready || this.parts || this.seq < this.target) return;
      this.ready = true;
      this.callbacks.ready(true);
    }).catch(error => {
      if (epoch !== this.epoch) return;
      // Control is released by close or transferred via an explicit resync
      // event; rejecting the in-flight acknowledgement is not a stream fault.
      if (error instanceof Error && error.message.includes('not controlling connection')) {
        this.ready = false;
        this.callbacks.ready(false);
        return;
      }
      this.failed = true;
      this.ready = false;
      this.callbacks.ready(false);
      this.callbacks.fault(error instanceof Error ? error : new Error(String(error)));
    });
    return this.serial;
  }

  dispose(): void { this.disconnect(); this.terminal?.dispose(); this.terminal = null; }

  private write(data: string): Promise<void> {
    const bytes = Uint8Array.from(atob(data), value => value.charCodeAt(0));
    return new Promise(resolve => this.terminal!.write(bytes, resolve));
  }
}
