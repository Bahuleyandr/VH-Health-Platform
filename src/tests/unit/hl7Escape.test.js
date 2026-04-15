// Unit tests for HL7v2 escape-sequence decoding + LOINC validator.

import { decodeHL7Escapes, parseHL7 } from '../../services/hl7/hl7Parser.js';
import { isInAllowlist, isValidStructure, validate } from '../../services/hl7/loincValidator.js';

describe('decodeHL7Escapes', () => {
  it('passes through strings with no backslashes (fast path)', () => {
    expect(decodeHL7Escapes('plain text')).toBe('plain text');
    expect(decodeHL7Escapes('')).toBe('');
    expect(decodeHL7Escapes(null)).toBeNull();
  });

  it('decodes the 5 canonical single-letter escapes', () => {
    expect(decodeHL7Escapes('a\\F\\b')).toBe('a|b'); // field separator
    expect(decodeHL7Escapes('a\\S\\b')).toBe('a^b'); // component separator
    expect(decodeHL7Escapes('a\\T\\b')).toBe('a&b'); // sub-component separator
    expect(decodeHL7Escapes('a\\R\\b')).toBe('a~b'); // repetition separator
    expect(decodeHL7Escapes('a\\E\\b')).toBe('a\\b'); // escape character
  });

  it('decodes multiple escapes in one string', () => {
    expect(decodeHL7Escapes('DOE\\R\\JOHN')).toBe('DOE~JOHN');
    expect(decodeHL7Escapes('A\\F\\B\\S\\C')).toBe('A|B^C');
  });

  it('decodes hex escapes (\\X..\\) into the underlying bytes', () => {
    // 0x7E = ~ (just to verify the hex path works even for chars we have a simple escape for)
    expect(decodeHL7Escapes('a\\X7E\\b')).toBe('a~b');
    // Multi-byte hex (German ä = UTF-8 0xC3 0xA4)
    expect(decodeHL7Escapes('M\\XC3A4\\nner')).toBe('Männer');
  });

  it('passes through unknown escapes unchanged', () => {
    // \H\ (highlight) is in the spec but we don't decode it.
    expect(decodeHL7Escapes('a\\H\\b')).toBe('a\\H\\b');
    // Random letter
    expect(decodeHL7Escapes('a\\Z\\b')).toBe('a\\Z\\b');
  });

  it('handles ill-formed hex without throwing', () => {
    // odd number of hex digits — Buffer.from will silently drop, but our regex
    // requires pairs so this won't match the regex; left unchanged.
    expect(decodeHL7Escapes('a\\X7\\b')).toBe('a\\X7\\b');
  });
});

describe('parseHL7 — escape decoding integration', () => {
  it('decodes \\R\\ inside PID name field (audit-flagged regression case)', () => {
    const msg = 'MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\rPID|1||MRN1||DOE\\R\\JOHN';
    const parsed = parseHL7(msg);
    // Before 2026-04-15, the parser would have left the literal `\R\` in place.
    expect(parsed.pid.name).toBe('DOE~JOHN');
  });

  it('decodes \\F\\ in patient address (legitimate use of an escaped pipe)', () => {
    // PID layout: 1=set-id, 3=MRN, 5=name, 7=dob, 8=sex, 11=address
    // Pipes:      0  1 2 3   4 5 6 7 8 9 10 11
    const msg = 'MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\rPID|1||MRN1||N||||||10 Main St\\F\\Apt 4';
    const parsed = parseHL7(msg);
    expect(parsed.pid.address).toBe('10 Main St|Apt 4');
  });

  it('leaves date fields raw (escape sequences are not legal in HL7 dates)', () => {
    const msg = 'MSH|^~\\&|A|B|C|D|20260415120000|||ADT^A01|1|P|2.5';
    const parsed = parseHL7(msg);
    expect(parsed.msh.dateTime).toBe('20260415120000');
  });
});

describe('LOINC structural validator', () => {
  it('accepts the canonical digit-hyphen-check shape', () => {
    expect(isValidStructure('8480-6')).toBe(true);
    expect(isValidStructure('8867-4')).toBe(true);
    expect(isValidStructure('2339-0')).toBe(true);
    expect(isValidStructure('59408-5')).toBe(true);
  });

  it('does NOT verify the LOINC check-digit algorithm (intentional — see source comment)', () => {
    // Structural validator accepts any single check digit; it doesn't compute
    // the LOINC mod-10 algorithm because the public spec is imprecise. The
    // allowlist or a future full-catalogue lookup is the real correctness gate.
    expect(isValidStructure('8480-7')).toBe(true);
    expect(isValidStructure('8480-9')).toBe(true);
  });

  it('rejects codes with no hyphen, wrong format, or non-numeric chars', () => {
    expect(isValidStructure('8480')).toBe(false);
    expect(isValidStructure('8480-')).toBe(false);
    expect(isValidStructure('-6')).toBe(false);
    expect(isValidStructure('LOINC-8480')).toBe(false);
    expect(isValidStructure('')).toBe(false);
    expect(isValidStructure(null)).toBe(false);
  });

  it('rejects codes with too many digits before the hyphen (>7)', () => {
    expect(isValidStructure('12345678-9')).toBe(false);
  });

  it('rejects codes with multiple check digits after the hyphen', () => {
    expect(isValidStructure('8480-67')).toBe(false);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidStructure('  8480-6  ')).toBe(true);
  });
});

describe('LOINC allowlist', () => {
  it('accepts hospital-tracked vitals + chem + CBC codes', () => {
    expect(isInAllowlist('8480-6')).toBe(true);  // Systolic BP
    expect(isInAllowlist('718-7')).toBe(true);   // Hemoglobin
    expect(isInAllowlist('6690-2')).toBe(true);  // WBC
  });

  it('rejects valid LOINC codes that are NOT in the hospital allowlist', () => {
    // 8302-2 is in the allowlist (Body height), so pick something that isn't —
    // 14749-6 is "Glucose [Moles/volume] in Serum or Plasma" — valid LOINC, not in our set.
    expect(isInAllowlist('14749-6')).toBe(false);
    expect(isValidStructure('14749-6')).toBe(true); // structurally valid
  });
});

describe('validate (combined)', () => {
  it('strict mode requires allowlist membership', () => {
    expect(validate('8480-6')).toEqual({ valid: true });
    expect(validate('14749-6')).toEqual({ valid: false, reason: 'not-in-allowlist' });
  });

  it('non-strict mode accepts any structurally valid code', () => {
    expect(validate('14749-6', { strict: false })).toEqual({ valid: true });
  });

  it('always rejects structurally invalid codes regardless of strict flag', () => {
    // No hyphen → fails structure check.
    expect(validate('8480')).toEqual({ valid: false, reason: 'invalid-structure' });
    expect(validate('8480', { strict: false })).toEqual({ valid: false, reason: 'invalid-structure' });
  });
});
