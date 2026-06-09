// Roadmap B1 — Code 39 wristband barcode generator (pure).

import { code39Runs, code39Svg, isCode39Encodable } from '../../utils/barcode/code39.js';

describe('code39 encodability', () => {
  test('uppercased UUIDs and VHMP pack codes are encodable', () => {
    expect(isCode39Encodable('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    expect(isCode39Encodable('550e8400-e29b-41d4-a716-446655440000')).toBe(true); // upcased internally
    expect(isCode39Encodable('VHMP-123-ABCD1234')).toBe(true);
  });
  test('rejects unencodable input', () => {
    expect(isCode39Encodable('naïve')).toBe(false);
    expect(isCode39Encodable('star*star')).toBe(false);
    expect(isCode39Encodable('')).toBe(false);
    expect(isCode39Encodable(null)).toBe(false);
  });
});

describe('code39 runs', () => {
  test('wraps content in start/stop sentinels with inter-char gaps', () => {
    const runs = code39Runs('A');
    // *A* → 3 chars × 9 elements + 2 inter-char gaps
    expect(runs).toHaveLength(3 * 9 + 2);
    // First element of '*' pattern (010010100) is a narrow bar.
    expect(runs[0]).toEqual({ width: 1, bar: true });
    // Elements alternate bar/space within each pattern.
    expect(runs[1].bar).toBe(false);
    // Every width is 1 or 3 (narrow/wide, ratio 3:1).
    for (const run of runs) expect([1, 3]).toContain(run.width);
  });

  test('throws on unencodable text', () => {
    expect(() => code39Runs('bad*text')).toThrow(/not Code 39 encodable/);
  });
});

describe('code39 svg', () => {
  test('renders a self-contained SVG with quiet zones and label', () => {
    const svg = code39Svg('VHMP-42-CAFE', { module: 2, height: 40 });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('VHMP-42-CAFE');
    expect(svg).toContain('rect');
    expect(svg.endsWith('</svg>')).toBe(true);
  });
  test('label can be suppressed', () => {
    const svg = code39Svg('123', { label: false });
    expect(svg).not.toContain('<text');
  });
});
