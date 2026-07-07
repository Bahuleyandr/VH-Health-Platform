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
});
