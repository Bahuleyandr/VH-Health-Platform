// Unit tests for HL7v2 escape-sequence decoding + LOINC validator.

import { decodeHL7Escapes, parseHL7 } from '../../services/hl7/hl7Parser.js';
import {
  encodeHL7Field,
  admissionToADT,
  formatVhInvestigationOrderId,
  orderToORM,
  resultToORU,
} from '../../services/hl7/hl7Transformer.js';
import { isInAllowlist, isValidStructure, validate } from '../../services/hl7/loincValidator.js';

// audit 2026-06-22 H7 — outbound HL7 must escape delimiter characters in text
// fields, or a patient-editable value forges fields/segments downstream.
describe('encodeHL7Field (outbound injection guard)', () => {
  it('escapes the 5 delimiter characters', () => {
    expect(encodeHL7Field('a|b')).toBe('a\\F\\b');
    expect(encodeHL7Field('a^b')).toBe('a\\S\\b');
    expect(encodeHL7Field('a&b')).toBe('a\\T\\b');
    expect(encodeHL7Field('a~b')).toBe('a\\R\\b');
    expect(encodeHL7Field('a\\b')).toBe('a\\E\\b');
  });

  it('escapes the backslash FIRST so introduced escapes are not double-encoded', () => {
    // '|' → '\F\'; the backslashes in '\F\' must NOT then become '\E\'.
    expect(encodeHL7Field('|')).toBe('\\F\\');
    expect(decodeHL7Escapes(encodeHL7Field('|'))).toBe('|');
  });

  it('hex-escapes CR/LF so they cannot inject a new segment', () => {
    expect(encodeHL7Field('a\rb')).toBe('a\\X0D\\b');
    expect(encodeHL7Field('a\nb')).toBe('a\\X0A\\b');
  });

  it('coerces null/undefined/number to a safe string', () => {
    expect(encodeHL7Field(null)).toBe('');
    expect(encodeHL7Field(undefined)).toBe('');
    expect(encodeHL7Field(42)).toBe('42');
  });

  it('round-trips losslessly through decodeHL7Escapes (inverse property)', () => {
    const samples = [
      'DOE^JOHN',
      'A|B|C',
      '10 Main St\r\nApt 4',
      'value~with&all|delimiters^and\\backslash',
      'पेशेंट नाम', // non-ASCII passes through untouched (no delimiters)
    ];
    for (const s of samples) {
      expect(decodeHL7Escapes(encodeHL7Field(s))).toBe(s);
    }
  });
});

describe('outbound HL7 builders escape malicious values (H7)', () => {
  it('a forged patient name cannot inject extra PID fields or a new segment', () => {
    const patient = {
      uid: 'u-1',
      // Attempt to inject an SSN field + a whole new OBR segment.
      name: 'EVIL||999-99-9999\rOBR|1|HACK',
      address: '1 St',
      phone: '555',
      birthday: null,
      gender: 'male',
    };
    const msg = admissionToADT({ ward: 'W', bed: '1', id: 'a1' }, patient);
    const lines = msg.split('\r');
    // Exactly 3 segments (MSH, PID, PV1) — the injected "OBR" did not become one.
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith('PID|')).toBe(true);
    // The raw injection markers are escaped, not literal, in the PID line.
    expect(lines[1]).toContain('\\F\\'); // the '|' chars were escaped
    expect(lines[1]).toContain('\\X0D\\'); // the CR was hex-escaped
    expect(lines[1]).not.toContain('999-99-9999|'); // no literal injected field break
    // Round-trip back through the parser recovers the original name verbatim.
    expect(parseHL7(msg).pid.name).toBe('EVIL||999-99-9999\rOBR|1|HACK');
  });

  it('a malicious lab result value cannot forge an OBX field', () => {
    const investigation = {
      test_name: 'Glucose',
      results: ['12|F|CRITICAL\rOBX|99|ST|FORGED'],
    };
    const msg = resultToORU(investigation, { uid: 'u', name: 'N' });
    const lines = msg.split('\r');
    // MSH, PID, OBR, OBX — exactly 4 segments; the injected OBX is escaped.
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith('OBX|'))).toHaveLength(1);
    expect(lines[3]).toContain('\\F\\');
    expect(lines[3]).toContain('\\X0D\\');
  });
});

describe('outbound investigation order namespace', () => {
  it('emits the same explicit VHINV identity for ORM and ORU investigation messages', () => {
    const investigation = {
      id: 42,
      test_code: 'GLU',
      test_name: 'Glucose',
      status: 'PENDING',
      results: [{ test_code: 'GLU', name: 'Glucose', value: '4.1' }],
    };
    const patient = { uid: 'patient-1', name: 'Patient' };

    const strictOptions = { enforceLocalOrderContract: true };
    const parsedOrm = parseHL7(orderToORM(investigation, patient, strictOptions));
    expect(parsedOrm.obr.placerOrderNumber).toBe('VHINV-42');
    expect(parsedOrm.obr.testCode).toBe('GLU^Glucose');
    const parsedOru = parseHL7(resultToORU(investigation, patient, strictOptions));
    expect(parsedOru.obr.placerOrderNumber).toBe('VHINV-42');
    expect(parsedOru.obr.testCode).toBe('GLU^Glucose');
    expect(parsedOru.obx[0].observationId).toBe('GLU^Glucose');
    expect(formatVhInvestigationOrderId('42')).toBe('VHINV-42');
  });

  it.each([0, -1, 2_147_483_648, '1.5', 'not-an-id'])(
    'refuses to emit an invalid local investigation id (%s)',
    (id) => {
      expect(() => formatVhInvestigationOrderId(id)).toThrow(
        'Investigation id must be a positive PostgreSQL integer',
      );
    },
  );

  it('refuses to label an unstructured or mismatched observation as a local investigation result', () => {
    const patient = { uid: 'patient-1', name: 'Patient' };
    expect(() => resultToORU({
      id: 42,
      test_code: 'GLU',
      test_name: 'Glucose',
      results: [{ test_code: 'K', name: 'Potassium', value: '4.1' }],
    }, patient, { enforceLocalOrderContract: true })).toThrow('matching structured test_code');
    expect(() => orderToORM(
      { id: 42, test_name: 'Glucose' },
      patient,
      { enforceLocalOrderContract: true },
    ))
      .toThrow('require a structured test_code');
  });

  it('preserves generic multi-component outbound ORU generation outside the strict route', () => {
    const parsed = parseHL7(resultToORU({
      id: 42,
      test_code: 'BMP',
      test_name: 'Basic metabolic panel',
      results: [
        { test_code: 'NA', name: 'Sodium', value: '140' },
        { test_code: 'K', name: 'Potassium', value: '4.1' },
      ],
    }, { uid: 'patient-1', name: 'Patient' }));

    expect(parsed.obx.map(result => result.observationId)).toEqual([
      'NA^Sodium',
      'K^Potassium',
    ]);
  });
});

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

  it('accepts extended vitals added in the 2026-04-17 allowlist expansion', () => {
    expect(isInAllowlist('72514-3')).toBe(true); // Pain severity 0-10
    expect(isInAllowlist('9269-2')).toBe(true);  // GCS total
    expect(isInAllowlist('8280-0')).toBe(true);  // Waist circumference
  });

  it('accepts diabetes panel (fasting + 2h post-meal glucose)', () => {
    expect(isInAllowlist('1558-6')).toBe(true);  // Fasting glucose
    expect(isInAllowlist('1521-4')).toBe(true);  // 2h post-meal
  });

  it('accepts extended CBC indices (MCV / MCH / MCHC / RDW / Neut% / Lymph%)', () => {
    expect(isInAllowlist('787-2')).toBe(true);
    expect(isInAllowlist('785-6')).toBe(true);
    expect(isInAllowlist('786-4')).toBe(true);
    expect(isInAllowlist('788-0')).toBe(true);
    expect(isInAllowlist('770-8')).toBe(true);
    expect(isInAllowlist('736-9')).toBe(true);
  });

  it('accepts thyroid panel (TSH / fT3 / fT4)', () => {
    expect(isInAllowlist('3016-3')).toBe(true);
    expect(isInAllowlist('3026-2')).toBe(true);
    expect(isInAllowlist('3051-0')).toBe(true);
  });

  it('accepts iron panel + inflammation markers', () => {
    expect(isInAllowlist('2498-4')).toBe(true);   // Iron
    expect(isInAllowlist('2500-7')).toBe(true);   // TIBC
    expect(isInAllowlist('2502-3')).toBe(true);   // Transferrin saturation
    expect(isInAllowlist('2276-4')).toBe(true);   // Ferritin
    expect(isInAllowlist('1988-5')).toBe(true);   // CRP
    expect(isInAllowlist('30341-2')).toBe(true);  // ESR
  });

  it('accepts expanded coagulation + cardiac markers (aPTT, D-dimer, BNP)', () => {
    expect(isInAllowlist('14979-9')).toBe(true);  // aPTT
    expect(isInAllowlist('30240-6')).toBe(true);  // D-dimer
    expect(isInAllowlist('30934-4')).toBe(true);  // BNP
    expect(isInAllowlist('14804-9')).toBe(true);  // LDH
  });

  it('accepts urinalysis dipstick codes', () => {
    expect(isInAllowlist('20405-7')).toBe(true);  // Urine protein
    expect(isInAllowlist('5792-7')).toBe(true);   // Urine glucose
    expect(isInAllowlist('5797-6')).toBe(true);   // Urine ketones
    expect(isInAllowlist('5799-2')).toBe(true);   // Urine leuk esterase
    expect(isInAllowlist('5802-4')).toBe(true);   // Urine nitrite
  });

  it('rejects valid LOINC codes that are NOT in the hospital allowlist', () => {
    // 72133-2 is "Pain severity — Wong-Baker FACES" — valid LOINC, deliberately
    // not in our set (we use the 0-10 numeric rating instead). If this test
    // fails because 72133-2 got added, update it to a different out-of-set code.
    expect(isInAllowlist('72133-2')).toBe(false);
    expect(isValidStructure('72133-2')).toBe(true); // structurally valid
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
