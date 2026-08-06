// Unit tests for HL7v2 parser. Pure function — no DB / no HTTP.
//
// Locks in the parser's documented limits:
//   - Pipe-delimited only (no `^~\&` escape handling).
//   - CR/LF/CRLF segment separators all accepted.
//   - Missing segments / fields default to empty string, not throw.
//   - MSH, EVN, PID, PV1, ORC, OBR, OBX recognised; unknown segments preserved
//     in `parsed.segments` but not given a typed accessor.

import { parseHL7 } from '../../services/hl7/hl7Parser.js';

const ADT_A01 = [
  'MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260414120000||ADT^A01|MSGCTRL001|P|2.5',
  'PID|1||MRN12345^^^MRN||DOE^JOHN^A||19800101|M|||123 MAIN ST^^CHENNAI^TN^600001||+919000000001',
  'PV1|1|I|ICU^B12^01||||DR789^SMITH^JANE',
].join('\r');

const ORU_R01 = [
  'MSH|^~\\&|LAB|HOSP|EMR|HOSP|20260414|||ORU^R01|MSG002|P|2.5',
  'PID|1||MRN999||PATIENT^TEST||19900101|F',
  'OBR|1||LABORDER001|CBC^Complete Blood Count|||20260414100000',
  'OBX|1|NM|HGB^Hemoglobin||13.5|g/dL|12.0-16.0|N|||F',
  'OBX|2|NM|WBC^White Cells||7.2|10^3/uL|4.0-11.0|N|||F',
].join('\n');

describe('parseHL7', () => {
  describe('input validation', () => {
    it('throws on empty string', () => {
      expect(() => parseHL7('')).toThrow('non-empty string');
    });

    it('throws on null/undefined', () => {
      expect(() => parseHL7(null)).toThrow('non-empty string');
      expect(() => parseHL7(undefined)).toThrow('non-empty string');
    });

    it('throws on non-string types', () => {
      expect(() => parseHL7(42)).toThrow('non-empty string');
      expect(() => parseHL7({})).toThrow('non-empty string');
    });
  });

  describe('segment separators', () => {
    it('accepts \\r-separated segments (canonical HL7v2)', () => {
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\rPID|1||MRN1');
      expect(parsed.segments.length).toBe(2);
      expect(parsed.msh).toBeDefined();
      expect(parsed.pid).toBeDefined();
    });

    it('accepts \\n-separated segments', () => {
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\nPID|1||MRN1');
      expect(parsed.segments.length).toBe(2);
    });

    it('accepts \\r\\n-separated segments (Windows line endings)', () => {
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\r\nPID|1||MRN1');
      expect(parsed.segments.length).toBe(2);
    });

    it('strips leading/trailing whitespace', () => {
      const parsed = parseHL7('  \r\nMSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\r\n  ');
      expect(parsed.segments.length).toBe(1);
    });

    it('drops empty lines mid-message', () => {
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\r\r\rPID|1||MRN1');
      expect(parsed.segments.length).toBe(2);
    });
  });

  describe('MSH parsing', () => {
    it('extracts the standard MSH fields from an ADT^A01', () => {
      const parsed = parseHL7(ADT_A01);
      expect(parsed.msh).toMatchObject({
        sendingApp: 'SENDAPP',
        sendingFacility: 'SENDFAC',
        receivingApp: 'RECVAPP',
        receivingFacility: 'RECVFAC',
        dateTime: '20260414120000',
        messageType: 'ADT^A01',
        messageControlId: 'MSGCTRL001',
        processingId: 'P',
        version: '2.5',
      });
    });

    it('defaults missing MSH fields to empty string (does not throw)', () => {
      const parsed = parseHL7('MSH|^~\\&');
      expect(parsed.msh).toMatchObject({
        sendingApp: '',
        sendingFacility: '',
        receivingApp: '',
        receivingFacility: '',
      });
    });

    it('retains MSH-13 only as non-authoritative sender sequence evidence', () => {
      const parsed = parseHL7(
        'MSH|^~\\&|A|B|C|D|20260806103045+0530||ADT^A01|MSG-13|P|2.5|1042',
      );
      expect(parsed.msh.sequenceNumber).toBe('1042');
    });
  });

  describe('I03 reconciliation evidence', () => {
    it('extracts EVN-2, PV1-19, PV1-44, and PV1-45 without timestamp coercion', () => {
      const pv1 = Array(46).fill('');
      pv1[0] = 'PV1';
      pv1[1] = '1';
      pv1[2] = 'I';
      pv1[19] = 'VISIT-ADT-1042';
      pv1[44] = '20260806103045+0530';
      pv1[45] = '20260806113045+0530';
      const parsed = parseHL7([
        'MSH|^~\\&|A|B|C|D|20260806103045+0530||ADT^A03|MSG-EVN|P|2.5|1042',
        'EVN|A03|20260806103045+0530',
        'PID|1||11111111-1111-4111-8111-111111111111',
        pv1.join('|'),
      ].join('\r'));

      expect(parsed.evn).toEqual({ recordedDateTime: '20260806103045+0530' });
      expect(parsed.pv1).toMatchObject({
        visitNumber: 'VISIT-ADT-1042',
        admitDate: '20260806103045+0530',
        dischargeDate: '20260806113045+0530',
      });
      expect(parsed.segmentCounts).toMatchObject({ MSH: 1, EVN: 1, PID: 1, PV1: 1 });
      expect(Object.isFrozen(parsed.segmentCounts)).toBe(true);
    });

    it('extracts ORC-2 and ORC-9 while retaining OBR order identities', () => {
      const orc = Array(10).fill('');
      orc[0] = 'ORC';
      orc[1] = 'NW';
      orc[2] = 'PLACER-ORM-42';
      orc[9] = '20260806103145+0530';
      const parsed = parseHL7([
        'MSH|^~\\&|A|B|C|D|20260806103145+0530||ORM^O01|MSG-ORC|P|2.5|2042',
        'PID|1||11111111-1111-4111-8111-111111111111',
        orc.join('|'),
        'OBR|1|PLACER-OBR-42|FILLER-OBR-42|CBC^Complete Blood Count',
      ].join('\r'));

      expect(parsed.orc).toEqual({
        placerOrderNumber: 'PLACER-ORM-42',
        transactionDateTime: '20260806103145+0530',
      });
      expect(parsed.obr).toMatchObject({
        placerOrderNumber: 'PLACER-OBR-42',
        fillerOrderNumber: 'FILLER-OBR-42',
        testCode: 'CBC^Complete Blood Count',
      });
      expect(parsed.segmentCounts).toMatchObject({ MSH: 1, PID: 1, ORC: 1, OBR: 1 });
    });

    it('counts duplicate identity segments so recovery validation can fail closed', () => {
      const parsed = parseHL7([
        'MSH|^~\\&|A|B|C|D|20260806103045+0530||ADT^A01|MSG-DUP|P|2.5',
        'EVN|A01|20260806103045+0530',
        'EVN|A01|20260806103046+0530',
        'PID|1||11111111-1111-4111-8111-111111111111',
        'PID|1||22222222-2222-4222-8222-222222222222',
      ].join('\r'));

      expect(parsed.segmentCounts).toMatchObject({ MSH: 1, EVN: 2, PID: 2 });
      expect(parsed.segments.filter(segment => segment.type === 'EVN')).toHaveLength(2);
      expect(parsed.segments.filter(segment => segment.type === 'PID')).toHaveLength(2);
    });
  });

  describe('PID parsing', () => {
    it('extracts patient demographics from a PID segment', () => {
      const parsed = parseHL7(ADT_A01);
      expect(parsed.pid).toMatchObject({
        patientId: 'MRN12345^^^MRN',
        name: 'DOE^JOHN^A',
        birthDate: '19800101',
        gender: 'M',
        phone: '+919000000001',
      });
    });

    it('handles a PID with only required fields populated', () => {
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\rPID|1||MRN999');
      expect(parsed.pid.patientId).toBe('MRN999');
      expect(parsed.pid.name).toBe('');
    });
  });

  describe('OBX (observation) parsing — supports multiple per message', () => {
    it('aggregates multiple OBX segments into an array', () => {
      const parsed = parseHL7(ORU_R01);
      expect(Array.isArray(parsed.obx)).toBe(true);
      expect(parsed.obx.length).toBe(2);
      expect(parsed.obx[0]).toMatchObject({
        valueType: 'NM',
        observationId: 'HGB^Hemoglobin',
        value: '13.5',
        units: 'g/dL',
      });
      expect(parsed.obx[1]).toMatchObject({
        observationId: 'WBC^White Cells',
        value: '7.2',
      });
    });
  });

  describe('Unknown segments', () => {
    it('preserves unknown segment types in segments[] without typed accessor', () => {
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\rZZZ|custom|fields');
      expect(parsed.segments.length).toBe(2);
      expect(parsed.segments[1].type).toBe('ZZZ');
      expect(parsed.segments[1].fields[1]).toBe('custom');
      expect(parsed.zzz).toBeUndefined(); // no auto-accessor
    });
  });

  describe('Documented limitations (intentional, not bugs)', () => {
    it('does NOT decode the standard HL7 escape sequence — `^` stays as a literal', () => {
      // Real HL7v2 uses `^` as a sub-component separator. This parser treats
      // pipe-delimited fields as opaque strings and does not split on `^`.
      const parsed = parseHL7('MSH|^~\\&|A|B|C|D|2026|||ADT^A01|1|P|2.5\rPID|1||MRN^check^digit');
      expect(parsed.pid.patientId).toBe('MRN^check^digit');
    });
  });
});
