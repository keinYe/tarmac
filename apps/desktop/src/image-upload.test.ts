import test from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_MAX_BYTES, UPLOAD_PART_BYTES } from '../../../packages/protocol/src/index.ts';
import type { Request } from '../../../packages/protocol/src/index.ts';
import { imageKind, uploadImage } from './image-upload.ts';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytesOf = (text: string) => [...text].map(char => char.charCodeAt(0));

test('image kinds come from the file signature, not the name', () => {
  assert.equal(imageKind(new Uint8Array([...PNG, 0])), 'png');
  assert.equal(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(imageKind(new Uint8Array(bytesOf('GIF89a...'))), 'gif');
  assert.equal(imageKind(new Uint8Array([...bytesOf('RIFF'), 0, 0, 0, 0, ...bytesOf('WEBPVP8 ')])), 'webp');
  assert.equal(imageKind(new Uint8Array(bytesOf('RIFF\0\0\0\0WAVE'))), null);
  assert.equal(imageKind(new Uint8Array(bytesOf('hello'))), null);
  assert.equal(imageKind(new Uint8Array(PNG.slice(0, 4))), null);
});

test('an image is sent in ordered parts of one upload and resolves with the saved path', async () => {
  const image = new Uint8Array(UPLOAD_PART_BYTES * 2 + 123);
  image.set(PNG);
  for (let index = PNG.length; index < image.length; index++) image[index] = index % 251;
  const sent: Extract<Request, { type: 'upload' }>[] = [];
  const saved = await uploadImage(image, { sessionId: 's', instanceId: 'i' }, async request => {
    assert.equal(request.type, 'upload');
    const part = request as Extract<Request, { type: 'upload' }>;
    sent.push(part);
    return part.part === part.parts - 1 ? '/data/uploads/s/x.png' : null;
  });
  assert.equal(saved, '/data/uploads/s/x.png');
  assert.deepEqual(sent.map(part => [part.part, part.parts, part.kind, part.sessionId, part.instanceId]),
    [[0, 3, 'png', 's', 'i'], [1, 3, 'png', 's', 'i'], [2, 3, 'png', 's', 'i']]);
  assert.equal(new Set(sent.map(part => part.uploadId)).size, 1);
  assert.match(sent[0].uploadId, /^[0-9a-f]{32}$/);
  assert.deepEqual(Buffer.concat(sent.map(part => Buffer.from(part.data, 'base64'))), Buffer.from(image));
});

test('non-images and oversized images are refused before anything is sent', async () => {
  let calls = 0;
  const send = async () => { calls++; return null; };
  await assert.rejects(uploadImage(new Uint8Array(bytesOf('not an image')), { sessionId: 's', instanceId: 'i' }, send), /PNG/);
  const huge = new Uint8Array(UPLOAD_MAX_BYTES + 1);
  huge.set(PNG);
  await assert.rejects(uploadImage(huge, { sessionId: 's', instanceId: 'i' }, send), /超过/);
  assert.equal(calls, 0);
});

test('a daemon that never answers with a path is an error', async () => {
  const image = new Uint8Array([...PNG, 1, 2, 3]);
  await assert.rejects(uploadImage(image, { sessionId: 's', instanceId: 'i' }, async () => null), /没有返回图片路径/);
});
