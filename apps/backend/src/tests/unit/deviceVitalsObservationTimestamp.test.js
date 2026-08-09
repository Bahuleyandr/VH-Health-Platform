// C-L5 — device observation timestamp extraction (pure units).
//
// parseHl7Timestamp: HL7 v2 TS `YYYYMMDD[HH[MM[SS[.S+]]]][±ZZZZ]` → JS Date;
// explicit ±ZZZZ offsets are honored, offset-less values use hospital time,
// and garbage is null. extractVitalsFromOru: observedAt comes from the
// first valid OBX-14, falls back to OBR-7, else null.

import { parseHL7 } from '../../services/hl7/hl7Parser.js';
import { extractVitalsFromOru, parseHl7Timestamp } from '../../services/emr/deviceVitalsService.js';

describe('parseHl7Timestamp', () => {
  test('full timestamp with positive offset resolves to the correct UTC instant', () => {
    const d = parseHl7Timestamp('20260610120000+0530');
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 10, 6, 30, 0));
  });

  test('full timestamp with negative offset resolves to the correct UTC instant', () => {
    const d = parseHl7Timestamp('20260610120000-0400');
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 10, 16, 0, 0));
  });

  test('offset-less timestamp is interpreted in hospital time, independent of server TZ', () => {
    const d = parseHl7Timestamp('20260610120000');
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 10, 6, 30, 0));
  });

  test('fractional seconds are carried as milliseconds', () => {
    const d = parseHl7Timestamp('20260610120000.5');
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 10, 6, 30, 0, 500));

    // HL7 can supply precision finer than JavaScript milliseconds. Keep the
    // represented instant within the same second rather than rounding over.
    const fine = parseHl7Timestamp('20260610120000.9999');
    expect(fine.getTime()).toBe(Date.UTC(2026, 5, 10, 6, 30, 0, 999));
  });

  test('short forms: hour and minute precision parse; date-only does not', () => {
    expect(parseHl7Timestamp('2026061012').getTime())
      .toBe(Date.UTC(2026, 5, 10, 6, 30, 0));
    expect(parseHl7Timestamp('202606101215').getTime())
      .toBe(Date.UTC(2026, 5, 10, 6, 45, 0));
    // A bare date carries no usable time-of-day for a clinical observation —
    // reject so the caller falls back to the receipt time.
    expect(parseHl7Timestamp('20260610')).toBeNull();
    expect(parseHl7Timestamp('20260610+0530')).toBeNull();
  });

  test('an invalid configured hospital timezone fails closed', () => {
    expect(parseHl7Timestamp('20260610120000', 'Not/A_Zone')).toBeNull();
  });

  test('offsets are bounded to the real-world UTC-offset range', () => {
    // ±14:00 is the extreme legal offset; minutes must be a valid 0-59.
    expect(parseHl7Timestamp('20260610120000+1400').getTime())
      .toBe(Date.UTC(2026, 5, 9, 22, 0, 0));
    expect(parseHl7Timestamp('20260610120000-1400').getTime())
      .toBe(Date.UTC(2026, 5, 11, 2, 0, 0));
    expect(parseHl7Timestamp('20260610120000+1500')).toBeNull();
    expect(parseHl7Timestamp('20260610120000-1500')).toBeNull();
    expect(parseHl7Timestamp('20260610120000+1401')).toBeNull();
    expect(parseHl7Timestamp('20260610120000-1430')).toBeNull();
    expect(parseHl7Timestamp('20260610120000+0560')).toBeNull();
  });

  test.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
    ['garbage', 'notadate'],
    ['too short', '2026'],
    ['odd length', '202606101'],
    ['month 13', '20261301120000'],
    ['month 00', '20260010120000'],
    ['Feb 30 rollover', '2026023012'],
    ['day 00', '2026060012'],
    ['hour 25', '20260610250000'],
    ['minute 61', '20260610126100'],
    ['second 61', '20260610120061'],
    ['bad offset length', '20260610120000+05'],
    ['embedded junk', '2026061012zz00'],
  ])('returns null for invalid input (%s)', (_label, input) => {
    expect(parseHl7Timestamp(input)).toBeNull();
  });

  test('leap-day is accepted in a leap year only', () => {
    expect(parseHl7Timestamp('2024022912')).toBeInstanceOf(Date);
    expect(parseHl7Timestamp('2026022912')).toBeNull();
  });
});

describe('extractVitalsFromOru observation timestamp', () => {
  const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const build = (segments) => extractVitalsFromOru(parseHL7(segments.join('\r')));

  test('uses the first valid OBX-14 across OBX segments', () => {
    const out = build([
      'MSH|^~\\&|MON|ICU||VH|20260610130000||ORU^R01|CID1|P|2.5',
      `PID|1||${UID}||TS^Patient`,
      'OBR|1|||VITALS|||20260610110000',
      'OBX|1|NM|8867-4^HR||80|/min|||||F', // no OBX-14
      'OBX|2|NM|59408-5^SpO2||97|%|||||F|||20260610120500',
      'OBX|3|NM|9279-1^RR||16|/min|||||F|||20260610999999', // later invalid ignored
    ]);
    expect(out.observedAt).toBeInstanceOf(Date);
    expect(out.observedAt.getTime()).toBe(Date.UTC(2026, 5, 10, 6, 35, 0));
    expect(out.observedAtSource).toBe('obx14');
    // Observation objects keep their original shape.
    expect(out.observations).toHaveLength(3);
    expect(out.observations[0]).toMatchObject({ loinc_code: '8867-4', value_numeric: 80 });
  });

  test('falls back to OBR-7 when no OBX carries a valid OBX-14', () => {
    const out = build([
      'MSH|^~\\&|MON|ICU||VH|20260610130000||ORU^R01|CID2|P|2.5',
      `PID|1||${UID}||TS^Patient`,
      'OBR|1|||VITALS|||20260610113000',
      'OBX|1|NM|8867-4^HR||80|/min|||||F',
    ]);
    expect(out.observedAt.getTime()).toBe(Date.UTC(2026, 5, 10, 6, 0, 0));
    expect(out.observedAtSource).toBe('obr7');
  });

  test('returns null observedAt when neither OBX-14 nor OBR-7 is present', () => {
    const out = build([
      'MSH|^~\\&|MON|ICU||VH|20260610130000||ORU^R01|CID3|P|2.5',
      `PID|1||${UID}||TS^Patient`,
      'OBR|1|||VITALS',
      'OBX|1|NM|8867-4^HR||80|/min|||||F',
    ]);
    expect(out.observedAt).toBeNull();
    expect(out.observedAtSource).toBeNull();
  });

  test('invalid OBX-14 with no OBR at all yields null', () => {
    const out = build([
      'MSH|^~\\&|MON|ICU||VH|20260610130000||ORU^R01|CID4|P|2.5',
      `PID|1||${UID}||TS^Patient`,
      'OBX|1|NM|8867-4^HR||80|/min|||||F|||garbage',
    ]);
    expect(out.observedAt).toBeNull();
    expect(out.observedAtSource).toBeNull();
  });
});
