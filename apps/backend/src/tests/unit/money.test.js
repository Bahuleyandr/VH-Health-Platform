import { toPaise, fromPaise, assertWholePaise } from '../../utils/money.js';

describe('money paise util', () => {
  it('converts rupees (number or string) to integer paise without float drift', () => {
    expect(toPaise('1000.00')).toBe(100000);
    expect(toPaise(1000)).toBe(100000);
    expect(toPaise('0.1')).toBe(10);
    expect(toPaise('19.99')).toBe(1999);
    // the classic float trap: 0.1 + 0.2 in rupees must not lose a paisa
    expect(toPaise('0.3')).toBe(30);
    expect(toPaise('1234567.89')).toBe(123456789);
  });

  it('rejects sub-paisa precision rather than silently rounding', () => {
    expect(() => toPaise('1.234')).toThrow(/paisa/i);
  });

  it('round-trips paise back to a 2dp rupee string', () => {
    expect(fromPaise(100000)).toBe('1000.00');
    expect(fromPaise(1999)).toBe('19.99');
    expect(fromPaise(-2500)).toBe('-25.00');
    expect(fromPaise(5)).toBe('0.05');
  });

  it('assertWholePaise rejects non-integers', () => {
    expect(() => assertWholePaise(10.5)).toThrow();
    expect(assertWholePaise(10)).toBe(10);
  });
});
