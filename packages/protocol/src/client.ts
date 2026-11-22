import net from 'node:net';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { VERSION, LIMITS, encodeFrame } from './index.ts';
import type { Request, ServerFrame, ServerEvent } from './index.ts';

const MAX_IN_FLIGHT = 8;
const MAX_QUEUED = 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

interface PendingRequest {
  id: string;
  line: string;
  bytes: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class Client extends EventEmitter {
  private socket: Duplex;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private queue: PendingRequest[] = [];
  private bufferedBytes = 0;
  private blocked = false;
  private closed = false;
  private constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > LIMITS.frameBytes && !this.buffer.includes('\n')) return socket.destroy(new Error('frame exceeds limit'));
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        try {
          if (Buffer.byteLength(line) > LIMITS.frameBytes) throw new Error('frame exceeds limit');
          const frame = JSON.parse(line) as ServerFrame;
          if (frame.v !== VERSION) throw new Error('protocol version mismatch');
          if (frame.type === 'result') {
            const pending = this.pending.get(frame.id);
            if (!pending) continue;
            this.pending.delete(frame.id);
            this.finish(pending, frame.ok ? undefined : new Error(frame.error ?? 'request failed'), frame.value);
            this.pump();
          } else this.emit('event', frame satisfies ServerEvent);
        } catch (error) { socket.destroy(error as Error); break; }
      }
    });
    socket.on('drain', () => { this.blocked = false; this.pump(); });
    socket.on('error', error => this.emit('fault', error));
    socket.on('close', () => {
      this.failAll(new Error('daemon disconnected'));
      this.emit('disconnect');
    });
  }
  static async connect(path: string, timeoutMs = 2000, token?: string): Promise<Client> {
    const socket = net.createConnection(path);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });
    const client = new Client(socket);
    if (token === undefined) return client;
    try { await client.request({ type: 'auth', token }, timeoutMs); }
    catch (error) { client.close(); throw error; }
    return client;
  }
  // A transport other than the local socket, such as an SSH bridge's stdio (apps/desktop/src/remote.ts).
  static over(stream: Duplex): Client { return new Client(stream); }
  request<T = unknown>(request: Request, timeoutMs = 5000): Promise<T> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error('daemon disconnected'));
    const id = randomUUID();
    let line: string;
    try { line = encodeFrame({ ...request, v: VERSION, id }); }
    catch (error) { return Promise.reject(error); }
    const bytes = Buffer.byteLength(line);
    if (this.queue.length >= MAX_QUEUED) return Promise.reject(new Error('request queue exceeds limit'));
    if (this.bufferedBytes + bytes > MAX_BUFFERED_BYTES) return Promise.reject(new Error('request buffer exceeds limit'));
    return new Promise((resolve, reject) => {
      const task: PendingRequest = {
        id, line, bytes,
        resolve: value => resolve(value as T), reject,
        timer: setTimeout(() => {
          if (this.pending.has(id)) {
            // The daemon may still be executing a timed-out request. Closing
            // avoids releasing slots and sending an unbounded number behind it.
            this.failAll(new Error('request timeout'));
            this.socket.destroy();
          } else {
            const index = this.queue.indexOf(task);
            if (index >= 0) {
              this.queue.splice(index, 1);
              this.finish(task, new Error('request timeout before send'));
            }
          }
        }, timeoutMs),
      };
      this.bufferedBytes += bytes;
      this.queue.push(task);
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && !this.socket.destroyed && !this.blocked
      && this.pending.size < MAX_IN_FLIGHT && this.queue.length) {
      const task = this.queue.shift()!;
      this.pending.set(task.id, task);
      try { this.blocked = !this.socket.write(task.line); }
      catch (error) { this.failAll(error as Error); this.socket.destroy(); }
    }
  }

  private finish(task: PendingRequest, error?: Error, value?: unknown): void {
    clearTimeout(task.timer);
    this.bufferedBytes -= task.bytes;
    if (error) task.reject(error);
    else task.resolve(value);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const task of this.pending.values()) this.finish(task, error);
    for (const task of this.queue) this.finish(task, error);
    this.pending.clear();
    this.queue = [];
  }

  close(): void {
    this.failAll(new Error('daemon disconnected'));
    this.socket.destroy();
  }

  waitForDisconnect(timeoutMs = 5000): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.removeListener('disconnect', done); reject(new Error('daemon shutdown timeout')); }, timeoutMs);
      this.once('disconnect', done);
    });
  }
}
