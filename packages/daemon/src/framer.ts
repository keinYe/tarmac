import { LIMITS } from '../../protocol/src/index.ts';

type State = 'ground' | 'escape' | 'escape-intermediate' | 'csi' | 'osc' | 'string';

// This only finds transport boundaries; xterm remains the terminal interpreter.
// A snapshot can therefore never strand xterm halfway through a control sequence.
export class TerminalFramer {
  private state: State = 'ground';
  private utf8 = 0;
  private codepoint = 0;
  private minimum = 0;
  private pending = Buffer.alloc(0);

  get pendingBytes(): number { return this.pending.length; }

  push(data: Uint8Array): Buffer {
    const bytes = Buffer.concat([this.pending, data]);
    let boundary = 0;
    for (let i = this.pending.length; i < bytes.length; i++) {
      const byte = bytes[i];
      if (this.utf8 && byte >= 0x80 && byte <= 0xbf) {
        this.codepoint = this.codepoint * 64 + (byte & 0x3f);
        if (--this.utf8 === 0 && this.codepoint >= this.minimum && this.codepoint <= 0x10ffff
          && !(this.codepoint >= 0xd800 && this.codepoint <= 0xdfff)) this.consume(this.codepoint);
      } else {
        // A non-continuation cancels an incomplete UTF-8 character. Interpret the
        // new byte normally, while forwarding every original byte unchanged.
        this.utf8 = 0;
        if (byte < 0x80) this.consume(byte);
        else if (byte >= 0xc2 && byte <= 0xdf) {
          this.utf8 = 1; this.codepoint = byte & 0x1f; this.minimum = 0x80;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          this.utf8 = 2; this.codepoint = byte & 0x0f; this.minimum = 0x800;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          this.utf8 = 3; this.codepoint = byte & 0x07; this.minimum = 0x10000;
        }
      }
      if (this.state === 'ground' && this.utf8 === 0) boundary = i + 1;
    }
    const complete = bytes.subarray(0, boundary);
    this.pending = Buffer.from(bytes.subarray(boundary));
    if (this.pending.length > LIMITS.parseHighBytes) throw new Error('incomplete terminal sequence exceeds 1 MiB');
    return complete;
  }

  private consume(code: number): void {
    // xterm accepts UTF-8 encoded C1 controls as well as their ESC spellings.
    // These controls can interrupt an existing sequence, so inspect decoded
    // code points in every state, including OSC/DCS string content.
    if (code === 0x1b) { this.state = 'escape'; return; }
    if (code === 0x9b) { this.state = 'csi'; return; }
    if (code === 0x9d) { this.state = 'osc'; return; }
    if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) { this.state = 'string'; return; }
    if (code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f)) {
      this.state = 'ground'; return;
    }
    if (this.state === 'escape') {
      if (code === 0x5b) this.state = 'csi';
      else if (code === 0x5d) this.state = 'osc';
      else if ([0x50, 0x58, 0x5e, 0x5f].includes(code)) this.state = 'string';
      else if (code >= 0x20 && code <= 0x2f) this.state = 'escape-intermediate';
      else if (code >= 0x30 && code <= 0x7e) this.state = 'ground';
    } else if (this.state === 'escape-intermediate') {
      if (code >= 0x30 && code <= 0x7e) this.state = 'ground';
    } else if (this.state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) this.state = 'ground';
    } else if (this.state === 'osc' && code === 0x07) this.state = 'ground';
  }
}
