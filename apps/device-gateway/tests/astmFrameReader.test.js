import {
  ACK, AstmFrameReader, astmChecksum, CR, ENQ, EOT, ETB, ETX, frameAstm, LF, NAK, STX,
} from '../src/astmFrameReader.js';

const bytes = (...parts) => Buffer.concat(parts.map((part) => (
  Buffer.isBuffer(part) ? part : Buffer.from(Array.isArray(part) ? part : [part])
)));

describe('astmChecksum', () => {
  it('sums frame bytes modulo 256 as two uppercase hex characters', () => {
    // '1' (0x31) + 'A' (0x41) + ETX (0x03) = 0x75
    expect(astmChecksum(Buffer.from([0x31, 0x41, ETX]))).toBe('75');
    // Wraps modulo 256 and zero-pads.
    expect(astmChecksum(Buffer.alloc(256, 0xff))).toBe('00');
  });

  it('frameAstm produces a frame the reader verifies', () => {
    const reader = new AstmFrameReader();
    const events = reader.push(frameAstm({ fn: 1, text: 'H|\\^&|||Analyzer\r', last: true }));
    expect(events).toEqual([
      { type: 'frame', fn: 1, text: 'H|\\^&|||Analyzer\r', last: true },
    ]);
  });
});

describe('AstmFrameReader', () => {
  it('emits enq and eot events from the idle state', () => {
    const reader = new AstmFrameReader();
    expect(reader.push(Buffer.from([ENQ]))).toEqual([{ type: 'enq' }]);
    expect(reader.push(Buffer.from([EOT]))).toEqual([{ type: 'eot' }]);
  });

  it('parses an intermediate (ETB) frame as non-final', () => {
    const reader = new AstmFrameReader();
    const events = reader.push(frameAstm({ fn: 2, text: 'partial', last: false }));
    expect(events).toEqual([{ type: 'frame', fn: 2, text: 'partial', last: false }]);
  });

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const wire = frameAstm({ fn: 1, text: 'R|1|^^^GLU|5.8|mmol/L\r', last: true });
    const reader = new AstmFrameReader();
    const events = [];
    for (const byte of wire) events.push(...reader.push(Buffer.from([byte])));
    expect(events).toEqual([
      { type: 'frame', fn: 1, text: 'R|1|^^^GLU|5.8|mmol/L\r', last: true },
    ]);
  });

  it('rejects a checksum-corrupt frame with reason checksum', () => {
    const wire = frameAstm({ fn: 1, text: 'R|1|^^^GLU|5.8\r', last: true });
    // Corrupt one content byte without touching the checksum trailer.
    wire[5] ^= 0x01;
    const reader = new AstmFrameReader();
    expect(reader.push(wire)).toEqual([{ type: 'reject', reason: 'checksum' }]);
    // The reader resyncs: a following good frame still parses.
    expect(reader.push(frameAstm({ fn: 1, text: 'ok\r', last: true }))).toEqual([
      { type: 'frame', fn: 1, text: 'ok\r', last: true },
    ]);
  });

  it('accepts lowercase checksum hex from lenient senders', () => {
    const body = bytes('1'.charCodeAt(0), Buffer.from('L|1|N\r'), ETX);
    const checksum = astmChecksum(body).toLowerCase();
    const wire = bytes(STX, body, Buffer.from(checksum, 'ascii'), CR, LF);
    const reader = new AstmFrameReader();
    expect(reader.push(wire)).toEqual([{ type: 'frame', fn: 1, text: 'L|1|N\r', last: true }]);
  });

  it('rejects a frame with a non-digit frame number as malformed', () => {
    const body = bytes('X'.charCodeAt(0), Buffer.from('data'), ETX);
    const wire = bytes(STX, body, Buffer.from(astmChecksum(body), 'ascii'), CR, LF);
    const reader = new AstmFrameReader();
    expect(reader.push(wire)).toEqual([{ type: 'reject', reason: 'malformed' }]);
  });

  it('rejects a frame whose trailer is missing CR LF', () => {
    const body = bytes('1'.charCodeAt(0), Buffer.from('data'), ETX);
    const wire = bytes(STX, body, Buffer.from(astmChecksum(body), 'ascii'), LF, LF);
    const reader = new AstmFrameReader();
    expect(reader.push(wire)).toEqual([{ type: 'reject', reason: 'malformed' }]);
  });

  it('rejects a control byte inside the frame body as lost framing', () => {
    const reader = new AstmFrameReader();
    expect(reader.push(bytes(STX, '1'.charCodeAt(0), STX))).toEqual([
      { type: 'reject', reason: 'malformed' },
    ]);
  });

  it('bounds the in-flight frame so an endless unterminated stream cannot exhaust memory', () => {
    const reader = new AstmFrameReader({ maxFrameBytes: 64 });
    const events = reader.push(bytes(STX, '1'.charCodeAt(0), Buffer.alloc(200, 0x41)));
    expect(events).toEqual([{ type: 'reject', reason: 'frame_too_large' }]);
  });

  it('ignores idle-state line noise between transfers', () => {
    const reader = new AstmFrameReader();
    expect(reader.push(Buffer.from([LF, 0x41, CR]))).toEqual([]);
    expect(reader.push(Buffer.from([ENQ]))).toEqual([{ type: 'enq' }]);
  });
});
