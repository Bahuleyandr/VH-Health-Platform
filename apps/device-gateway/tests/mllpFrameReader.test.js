import { MllpFrameReader, frameMessage } from '../src/mllpFrameReader.js';

describe('MllpFrameReader', () => {
  it('reassembles split frames', () => {
    const reader = new MllpFrameReader();
    const frame = frameMessage('MSH|^~\\&|A\rPID|1');
    expect(reader.push(frame.subarray(0, 6))).toEqual([]);
    expect(reader.push(frame.subarray(6))).toEqual(['MSH|^~\\&|A\rPID|1']);
  });

  it('returns joined frames in order', () => {
    const reader = new MllpFrameReader();
    const out = reader.push(Buffer.concat([frameMessage('MSH|A'), frameMessage('MSH|B')]));
    expect(out).toEqual(['MSH|A', 'MSH|B']);
  });

  it('handles noisy interleaved chunks without emitting partial frames', () => {
    const reader = new MllpFrameReader();
    expect(reader.push(Buffer.from('noise'))).toEqual([]);
    expect(reader.push(frameMessage('MSH|C').subarray(0, 4))).toEqual([]);
    expect(reader.push(Buffer.concat([frameMessage('MSH|C').subarray(4), Buffer.from('tail')]))).toEqual(['MSH|C']);
  });

  it('bounds an unterminated frame and throws MLLP_FRAME_TOO_LARGE (Sol Ultra #25)', () => {
    const reader = new MllpFrameReader({ maxFrameBytes: 16 });
    const VT = 0x0b;
    // Start a frame then stream past the cap with no FS+CR end marker.
    const flood = Buffer.concat([Buffer.from([VT]), Buffer.from('X'.repeat(64))]);
    expect(() => reader.push(flood)).toThrow(/exceeds/i);
    try { reader.push(flood); } catch (err) { expect(err.code).toBe('MLLP_FRAME_TOO_LARGE'); }
    // After overflow the reader resets and parses the next well-formed frame.
    expect(reader.push(frameMessage('MSH|OK'))).toEqual(['MSH|OK']);
  });
});
