export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

export class MllpFrameReader {
  constructor() {
    this.inFrame = false;
    this.buffer = [];
    this.afterFs = false;
  }

  push(chunk) {
    const out = [];
    for (const byte of Buffer.from(chunk)) {
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
