import { randomBytes } from 'node:crypto';
import { UPLOAD_MAX_BYTES, UPLOAD_PART_BYTES } from '../../../packages/protocol/src/index.ts';
import type { Identity, Request, UploadKind } from '../../../packages/protocol/src/index.ts';

const starts = (bytes: Uint8Array, prefix: number[], offset = 0): boolean =>
  bytes.length >= offset + prefix.length && prefix.every((value, index) => bytes[offset + index] === value);
const ascii = (text: string): number[] => [...text].map(char => char.charCodeAt(0));

// The image kind from its signature; null for anything else.
export function imageKind(bytes: Uint8Array): UploadKind | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(bytes, ascii('GIF87a')) || starts(bytes, ascii('GIF89a'))) return 'gif';
  if (starts(bytes, ascii('RIFF')) && starts(bytes, ascii('WEBP'), 8)) return 'webp';
  return null;
}

// Sends an image to the daemon of the session's machine in order; resolves with the saved path.
export async function uploadImage(bytes: Uint8Array, identity: Identity, send: (request: Request) => Promise<unknown>): Promise<string> {
  const kind = imageKind(bytes);
  if (!kind) throw new Error('只支持 PNG、JPEG、GIF、WebP 图片');
  if (bytes.length > UPLOAD_MAX_BYTES) throw new Error(`图片超过 ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
  const uploadId = randomBytes(16).toString('hex');
  const parts = Math.ceil(bytes.length / UPLOAD_PART_BYTES);
  let saved: unknown = null;
  for (let part = 0; part < parts; part++) {
    const data = Buffer.from(bytes.subarray(part * UPLOAD_PART_BYTES, (part + 1) * UPLOAD_PART_BYTES)).toString('base64');
    saved = await send({ type: 'upload', sessionId: identity.sessionId, instanceId: identity.instanceId, uploadId, kind, part, parts, data });
  }
  if (typeof saved !== 'string') throw new Error('会话所在主机没有返回图片路径');
  return saved;
}
