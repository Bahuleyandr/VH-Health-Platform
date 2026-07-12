export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

// HL7v2 device messages are small (a few KB). Bound the in-flight frame so a
// peer that sends a start byte (VT) and then an endless stream with no end
// marker (FS+CR) cannot grow the per-connection buffer without limit and
// exhaust gateway memory (Sol Ultra #25). Overflow throws MLLP_FRAME_TOO_LARGE;
// the socket handler drops the connection.
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB

export class MllpFrameReader {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.inFrame = false;
    this.buffer = [];
    this.afterFs = false;
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    const out = [];
    for (const byte of Buffer.from(chunk)) {
      if (this.inFrame && this.buffer.length > this.maxFrameBytes) {
        this.inFrame = false;
        this.buffer = [];
        this.afterFs = false;
        const err = new Error(`MLLP frame exceeds ${this.maxFrameBytes} bytes`);
        err.code = 'MLLP_FRAME_TOO_LARGE';
        throw err;
      }
      if (!this.inFrame) {
        if (byte === VT) {
          this.inFrame = true;
          this.afterFs = false;
          this.buffer = [];
        }
        continue;
      }
      if (this.afterFs) {
        if (byte === CR) {
          out.push(Buffer.from(this.buffer).toString('utf8'));
          this.inFrame = false;
          this.afterFs = false;
          this.buffer = [];
          continue;
        }
        this.buffer.push(FS, byte);
        this.afterFs = false;
        continue;
      }
      if (byte === FS) {
        this.afterFs = true;
      } else {
        this.buffer.push(byte);
      }
    }
    return out;
  }
}

export function frameMessage(message) {
  return Buffer.concat([
    Buffer.from([VT]),
    Buffer.from(String(message), 'utf8'),
    Buffer.from([FS, CR]),
  ]);
}
