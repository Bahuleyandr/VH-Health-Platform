import { decodeStrictUtf8 } from './mllpFrameReader.js';

// ASTM E1381 / LIS1-A low-level frame layer, the transport lab analyzers use
// for ASTM E1394 (LIS2-A2) result messages over serial or TCP.
//
// Wire shape of one transfer:
//   <ENQ>                            sender requests the line -> receiver ACKs
//   <STX> FN text <ETB|ETX> C1 C2 <CR> <LF>   one frame; receiver ACKs or NAKs
//   ...                              ETB = intermediate frame, ETX = final
//   <EOT>                            sender releases the line (no reply)
//
// FN is a single ASCII digit cycling 1..7,0,1... C1 C2 are the checksum: the
// arithmetic sum of every byte from FN through the ETB/ETX inclusive, modulo
// 256, as two uppercase hex characters.
//
// This reader is pure and per-connection: push(chunk) consumes bytes and
// returns protocol events. It verifies STRUCTURE and CHECKSUM only; frame
// sequencing, record assembly, ACK/NAK policy, and durability live in the
// session layer (lisTransport.js) so a NAK-and-retransmit round trip can be
// driven by spool durability, not by the byte parser.
export const ENQ = 0x05;
export const ACK = 0x06;
export const NAK = 0x15;
export const STX = 0x02;
export const ETX = 0x03;
export const ETB = 0x17;
export const EOT = 0x04;
export const CR = 0x0d;
export const LF = 0x0a;

// One ASTM frame's text section is capped at 240 characters by the standard;
// real analyzers occasionally run long, so bound generously. Anything larger
// is a broken peer or an attack on gateway memory, mirroring the MLLP
// reader's MLLP_FRAME_TOO_LARGE bound.
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;

export function astmChecksum(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

// Build one framed message part (used by tests and any future bidirectional
// support). `text` is the frame content WITHOUT frame number or terminator.
export function frameAstm({ fn, text, last = true }) {
  const body = Buffer.concat([
    Buffer.from(String(fn), 'ascii'),
    Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8'),
    Buffer.from([last ? ETX : ETB]),
  ]);
  return Buffer.concat([
    Buffer.from([STX]),
    body,
    Buffer.from(astmChecksum(body), 'ascii'),
    Buffer.from([CR, LF]),
  ]);
}

const IDLE = 'idle';
const IN_FRAME = 'in_frame';
const CHECKSUM = 'checksum';
const TRAILER_CR = 'trailer_cr';
const TRAILER_LF = 'trailer_lf';

export class AstmFrameReader {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.reset();
  }

  reset() {
    this.state = IDLE;
    this.body = [];
    this.checksumChars = [];
    this.terminator = null;
  }

  // Consume a chunk, return an ordered list of protocol events:
  //   { type: 'enq' }                       sender requests the line
  //   { type: 'eot' }                       sender released the line
  //   { type: 'frame', fn, text, last }     structure + checksum verified
  //   { type: 'reject', reason }            reply NAK; reason is bounded:
  //     'checksum' | 'malformed' | 'frame_too_large'
  push(chunk) {
    const out = [];
    for (const byte of Buffer.from(chunk)) {
      if (this.state === IDLE) {
        if (byte === ENQ) out.push({ type: 'enq' });
        else if (byte === EOT) out.push({ type: 'eot' });
        else if (byte === STX) this.state = IN_FRAME;
        // Anything else between frames (stray LF, line noise) is ignored.
        continue;
      }
      if (this.state === IN_FRAME) {
        if (this.body.length > this.maxFrameBytes) {
          this.reset();
          out.push({ type: 'reject', reason: 'frame_too_large' });
          continue;
        }
        if (byte === ETX || byte === ETB) {
          this.terminator = byte;
          this.state = CHECKSUM;
        } else if (byte === STX || byte === ENQ || byte === EOT) {
          // A control byte inside the body means the peer lost framing.
          this.reset();
          out.push({ type: 'reject', reason: 'malformed' });
        } else {
          this.body.push(byte);
        }
        continue;
      }
      if (this.state === CHECKSUM) {
        this.checksumChars.push(byte);
        if (this.checksumChars.length === 2) this.state = TRAILER_CR;
        continue;
      }
      if (this.state === TRAILER_CR) {
        if (byte !== CR) {
          this.reset();
          out.push({ type: 'reject', reason: 'malformed' });
          continue;
        }
        this.state = TRAILER_LF;
        continue;
      }
      // TRAILER_LF
      if (byte !== LF) {
        this.reset();
        out.push({ type: 'reject', reason: 'malformed' });
        continue;
      }
      out.push(this.finishFrame());
      this.reset();
    }
    return out;
  }

  finishFrame() {
    const body = Buffer.from(this.body);
    if (body.length === 0) return { type: 'reject', reason: 'malformed' };
    const fnChar = String.fromCharCode(body[0]);
    if (!/^[0-7]$/.test(fnChar)) return { type: 'reject', reason: 'malformed' };
    const expected = astmChecksum(Buffer.concat([body, Buffer.from([this.terminator])]));
    const received = Buffer.from(this.checksumChars).toString('ascii').toUpperCase();
    if (received !== expected) return { type: 'reject', reason: 'checksum' };
    let text;
    try {
      text = decodeStrictUtf8(body.subarray(1));
    } catch {
      return { type: 'reject', reason: 'malformed' };
    }
    return {
      type: 'frame',
      fn: Number(fnChar),
      text,
      last: this.terminator === ETX,
    };
  }
}
