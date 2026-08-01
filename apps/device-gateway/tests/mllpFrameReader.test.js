import { MllpFrameReader, decodeStrictUtf8, frameMessage } from '../src/mllpFrameReader.js';

describe('MllpFrameReader', () => {
  it('reassembles split frames', () => {
    const reader = new MllpFrameReader();
    const frame = frameMessage('MSH|^~\\&|A\rPID|1');
    expect(reader.push(frame.subarray(0, 6))).toEqual([]);
    const [payload] = reader.push(frame.subarray(6));
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect(payload.toString('utf8')).toBe('MSH|^~\\&|A\rPID|1');
  });

  it('returns joined frames in order', () => {
    const reader = new MllpFrameReader();
    const out = reader.push(Buffer.concat([frameMessage('MSH|A'), frameMessage('MSH|B')]));
    expect(out.map((value) => value.toString('utf8'))).toEqual(['MSH|A', 'MSH|B']);
  });

  it('handles noisy interleaved chunks without emitting partial frames', () => {
    const reader = new MllpFrameReader();
    expect(reader.push(Buffer.from('noise'))).toEqual([]);
    expect(reader.push(frameMessage('MSH|C').subarray(0, 4))).toEqual([]);
    expect(reader.push(Buffer.concat([frameMessage('MSH|C').subarray(4), Buffer.from('tail')]))
      .map((value) => value.toString('utf8'))).toEqual(['MSH|C']);
  });

  it('bounds an unterminated frame and throws MLLP_FRAME_TOO_LARGE (Sol Ultra #25)', () => {
    const reader = new MllpFrameReader({ maxFrameBytes: 16 });
    const VT = 0x0b;
    // Start a frame then stream past the cap with no FS+CR end marker.
    const flood = Buffer.concat([Buffer.from([VT]), Buffer.from('X'.repeat(64))]);
    expect(() => reader.push(flood)).toThrow(/exceeds/i);
    try { reader.push(flood); } catch (err) { expect(err.code).toBe('MLLP_FRAME_TOO_LARGE'); }
    // After overflow the reader resets and parses the next well-formed frame.
    expect(reader.push(frameMessage('MSH|OK')).map((value) => value.toString('utf8'))).toEqual(['MSH|OK']);
  });

  it('preserves exact unframed bytes and rejects invalid UTF-8', () => {
    const reader = new MllpFrameReader();
    const bytes = Buffer.from('MSH|^~\\&|MON\rNTE|1||caf\u00e9', 'utf8');
    const [payload] = reader.push(frameMessage(bytes));
    expect(payload.equals(bytes)).toBe(true);
    expect(decodeStrictUtf8(payload)).toContain('caf\u00e9');

    expect(() => reader.push(Buffer.from([0x0b, 0x4d, 0x53, 0x48, 0xc3, 0x28, 0x1c, 0x0d])))
      .toThrow('not valid UTF-8');
  });
});
