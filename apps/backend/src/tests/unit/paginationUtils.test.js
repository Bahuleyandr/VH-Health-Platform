import { boundedInteger } from '../../utils/pagination.js';

describe('boundedInteger', () => {
  it.each([
    [undefined, 25],
    [null, 25],
    ['', 25],
    ['   ', 25],
    [true, 25],
    [false, 25],
    [[], 25],
    [{}, 25],
    ['0', 25],
    ['not-a-number', 25],
    ['1e309', 25],
    [1.9, 1],
    [-5, 1],
    [999_999, 200],
  ])('normalizes %p to a finite bounded integer', (value, expected) => {
    expect(boundedInteger(value, { fallback: 25, min: 1, max: 200 })).toBe(expected);
  });
});
