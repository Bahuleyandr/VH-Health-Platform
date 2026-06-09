// Roadmap B3 — ASTM E1394 parser (pure).

import { parseAstmMessage } from '../../services/lab/labClosedLoopService.js';

const SAMPLE = [
  'H|\\^&|||MINDRAY^BS-240|||||||P|E1394-97|20260610',
  'P|1',
  'O|1|ACC-B3-001||^^^GLU|R',
  'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
  'R|2|^^^K|6.9|mmol/L|3.5^5.1|H||F',
  'L|1|N',
].join('\r');

describe('parseAstmMessage', () => {
  test('extracts sender, accession and typed results', () => {
    const parsed = parseAstmMessage(SAMPLE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.sender).toBe('MINDRAY BS-240');
    expect(parsed.accession).toBe('ACC-B3-001');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({
      test_code: 'GLU', value_numeric: 5.8, unit: 'mmol/L',
      reference_range: '3.9-6.1', reference_low: 3.9, reference_high: 6.1,
      abnormal_flag: 'N', result_status: 'F',
    });
    expect(parsed.results[1]).toMatchObject({ test_code: 'K', value_numeric: 6.9, abnormal_flag: 'H' });
  });

  test('newline-separated records parse the same', () => {
    const parsed = parseAstmMessage(SAMPLE.replaceAll('\r', '\n'));
    expect(parsed.results).toHaveLength(2);
    expect(parsed.accession).toBe('ACC-B3-001');
  });

  test('missing O record and missing R records are reported, not thrown', () => {
    const noOrder = parseAstmMessage('H|\\^&\rR|1|^^^GLU|5.8|mmol/L\rL|1|N');
    expect(noOrder.accession).toBeNull();
    expect(noOrder.errors.some((e) => e.includes('no O record'))).toBe(true);

    const noResults = parseAstmMessage('H|\\^&\rO|1|ACC-1\rL|1|N');
    expect(noResults.errors.some((e) => e.includes('no R records'))).toBe(true);
    expect(parseAstmMessage('').errors).toContain('empty message');
  });

  test('non-numeric values keep value_text with null numeric', () => {
    const parsed = parseAstmMessage('H|\\^&\rO|1|ACC-2||^^^HBsAg|R\rR|1|^^^HBsAg|REACTIVE||^|A||F\rL|1');
    expect(parsed.results[0]).toMatchObject({ test_code: 'HBsAg', value_text: 'REACTIVE', value_numeric: null });
  });
});
