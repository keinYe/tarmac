import path from 'node:path';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { UPLOAD_ID, UPLOAD_KINDS, UPLOAD_MAX_BYTES, UPLOAD_PART_BYTES } from '../../protocol/src/index.ts';
import type { UploadKind } from '../../protocol/src/index.ts';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface UploadPart {
  uploadId: string;
  kind: UploadKind;
  part: number;
  parts: number;
  data: string;
}

interface Pending { sessionId: string; kind: UploadKind; parts: number; next: number; bytes: number; file: string }

function stamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

// Images pasted into sessions on this machine, under <dataDir>/uploads/<sessionId>/. A file
// exists only while its session lives: removed when the process exits and when the daemon starts.
export class UploadStore {
  readonly root: string;
  private pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) { this.root = root; }

  // Requests are applied one at a time, so the order checks hold across awaits.
  write(sessionId: string, part: UploadPart): Promise<string | null> {
    const task = this.queue.then(() => this.apply(sessionId, part));
    this.queue = task.catch(() => {});
    return task;
  }

  clearSession(sessionId: string): Promise<void> {
    const task = this.queue.then(async () => {
      for (const [id, entry] of this.pending) if (entry.sessionId === sessionId) this.pending.delete(id);
      await rm(path.join(this.root, sessionId), { recursive: true, force: true });
    });
    this.queue = task.catch(() => {});
    return task;
  }

  clearAll(): Promise<void> {
    const task = this.queue.then(async () => {
      this.pending.clear();
      await rm(this.root, { recursive: true, force: true });
    });
    this.queue = task.catch(() => {});
    return task;
  }

  private async apply(sessionId: string, request: UploadPart): Promise<string | null> {
    const { uploadId, kind, part, parts, data } = request;
    const maxParts = Math.ceil(UPLOAD_MAX_BYTES / UPLOAD_PART_BYTES);
    if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId) || !(UPLOAD_KINDS as readonly unknown[]).includes(kind)
      || !Number.isSafeInteger(parts) || parts < 1 || parts > maxParts
      || !Number.isSafeInteger(part) || part < 0 || part >= parts
      || typeof data !== 'string' || !data || !BASE64.test(data)) throw new Error('invalid upload');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > UPLOAD_PART_BYTES) throw new Error('invalid upload');
    let entry = this.pending.get(uploadId);
    if (part === 0) {
      if (entry) throw new Error('upload already started');
      const dir = path.join(this.root, sessionId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      entry = { sessionId, kind, parts, next: 0, bytes: 0, file: path.join(dir, `${uploadId}.part`) };
      this.pending.set(uploadId, entry);
    } else if (!entry || entry.sessionId !== sessionId || entry.kind !== kind || entry.parts !== parts || entry.next !== part) {
      throw new Error('upload part out of order');
    }
    try {
      if (entry.bytes + bytes.length > UPLOAD_MAX_BYTES) throw new Error('upload too large');
      const handle = await open(entry.file, part === 0 ? 'wx' : 'a', 0o600);
      try { await handle.write(bytes); } finally { await handle.close(); }
      entry.bytes += bytes.length;
      entry.next++;
      if (entry.next < parts) return null;
      this.pending.delete(uploadId);
      const saved = path.join(path.dirname(entry.file), `${stamp(new Date())}-${uploadId.slice(0, 8)}.${kind}`);
      await rename(entry.file, saved);
      return saved;
    } catch (error) {
      this.pending.delete(uploadId);
      await rm(entry.file, { force: true });
      throw error;
    }
  }
}
