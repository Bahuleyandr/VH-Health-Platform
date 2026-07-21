// Roadmap B3 — ASTM E1394 parser (pure).

import { parseAstmMessage } from '../../services/lab/labClosedLoopService.js';

const SAMPLE = [
  'H|\\^&|||MINDRAY^BS-240|||||||P|E1394-97|20260610',
  'P|1',
  'O|1|ACC-B3-001||^^^GLU|R',
  'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
  'L|1|N',
].join('\r');

describe('parseAstmMessage', () => {
  test('extracts sender, accession and typed results', () => {
    const parsed = parseAstmMessage(SAMPLE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.sender).toBe('MINDRAY BS-240');
    expect(parsed.accession).toBe('ACC-B3-001');
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({
      test_code: 'GLU', value_numeric: 5.8, unit: 'mmol/L',
      reference_range: '3.9-6.1', reference_low: 3.9, reference_high: 6.1,
      abnormal_flag: 'N', result_status: 'F',
    });
  });

  test('newline-separated records parse the same', () => {
    const parsed = parseAstmMessage(SAMPLE.replaceAll('\r', '\n'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.results).toHaveLength(1);
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

  test('fails closed when a multi-result message has no governed panel contract', () => {
    const parsed = parseAstmMessage(SAMPLE.replace(
      'L|1|N',
      'R|2|^^^K|6.9|mmol/L|3.5^5.1|H||F\rL|1|N',
    ));
    expect(parsed.errors).toContain(
      'multi-result ASTM messages require an explicit ordered-panel analyte contract',
    );
  });

  test('requires exact record tags and an exact O-to-R analyte binding', () => {
    const longTag = parseAstmMessage(SAMPLE.replace(/^H\|/, 'HEADER|'));
    expect(longTag.errors.some(error => error.includes('unsupported ASTM record type'))).toBe(true);

    const blankOrderTest = parseAstmMessage(SAMPLE.replace('^^^GLU|R', '|R'));
    expect(blankOrderTest.errors).toContain('O record requires an ordered test code');

    const wrongResult = parseAstmMessage(SAMPLE.replace('R|1|^^^GLU', 'R|1|^^^K'));
    expect(wrongResult.errors).toContain('single-result ASTM analyte does not match its O record');
  });

  test('normalizes analyte component whitespace before policy matching', () => {
    const parsed = parseAstmMessage(SAMPLE
      .replace('^^^GLU|R', '^^^ GLU |R')
      .replace('R|1|^^^GLU', 'R|1|^^^ GLU '));

    expect(parsed.errors).toEqual([]);
    expect(parsed.ordered_test_code).toBe('GLU');
    expect(parsed.results[0].test_code).toBe('GLU');

    const blankCode = parseAstmMessage(SAMPLE
      .replace('^^^GLU|R', '^^^   |R')
      .replace('R|1|^^^GLU', 'R|1|^^^   '));
    expect(blankCode.errors).toContain('O record requires an ordered test code');
    expect(blankCode.errors.some(error => error.includes('without a test code'))).toBe(true);
  });

  test('rejects incomplete result evidence and invalid envelope sequencing', () => {
    const blankValue = parseAstmMessage(SAMPLE.replace('|5.8|mmol/L|', '||mmol/L|'));
    expect(blankValue.errors.some(error => error.includes('has no result value'))).toBe(true);

    const corrected = parseAstmMessage(SAMPLE.replace('|N||F', '|N||C'));
    expect(corrected.errors.some(error => error.includes('not a supported final result'))).toBe(true);

    const sequenceZero = parseAstmMessage(SAMPLE.replace('R|1|', 'R|0|'));
    expect(sequenceZero.errors).toContain(
      'ASTM R record sequences must be positive, unique, and contiguous',
    );

    const trailing = parseAstmMessage(`${SAMPLE}\rC|unexpected`);
    expect(trailing.errors).toContain(
      'ASTM message must be one complete ordered H/(P)/O/R.../L envelope',
    );
  });
});
