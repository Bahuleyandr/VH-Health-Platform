// Regression tests for audit finding H5 (2026-06-10) — PHI (phone numbers,
// emails, MRNs) in plaintext logs.
//
// Proves:
//   1. The call-site maskers produce non-reversible representations.
//   2. The Winston backstop format scrubs phone/email/MRN patterns from
//      message, stack, and nested metadata.
//   3. A grep-style sweep: no `logger.*(...)` call site interpolates a raw
//      phone variable any more (the regression gate for this finding).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskPhoneForLog,
  maskEmailForLog,
  maskMrnForLog,
  scrubPhiFromString,
  scrubPhiDeep,
} from '../utils/logMasking.js';
import phiRedactionFormat from '../logging/phiRedactionFormat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..');

describe('H5 — PHI log masking', () => {
  describe('call-site maskers', () => {
    test('maskPhoneForLog hides the middle digits', () => {
      expect(maskPhoneForLog('+919876543210')).toBe('+91***10');
      expect(maskPhoneForLog('+919876543210')).not.toContain('98765432');
      expect(maskPhoneForLog('')).toBe('<no-phone>');
      expect(maskPhoneForLog(null)).toBe('<no-phone>');
      expect(maskPhoneForLog('12345')).toBe('<short-phone>');
    });

    test('maskEmailForLog hides the local part', () => {
      expect(maskEmailForLog('patient.name@example.com')).toBe('p***@example.com');
      expect(maskEmailForLog('')).toBe('<no-email>');
    });

    test('maskMrnForLog keeps only a 3-char suffix', () => {
      expect(maskMrnForLog('MRN-2026-00451')).toBe('***451');
    });
  });

  describe('scrubPhiFromString (Winston backstop)', () => {
    test('masks E.164 and bare Indian mobile numbers', () => {
      expect(scrubPhiFromString('OTP generated for +919876543210 ok'))
        .not.toContain('+919876543210');
      expect(scrubPhiFromString('reminder to 9876543210 sent'))
        .not.toContain('9876543210');
    });

    test('masks emails', () => {
      const out = scrubPhiFromString('login by someone@example.org failed');
      expect(out).not.toContain('someone@example.org');
      expect(out).toContain('@example.org'); // domain retained for debugging
    });

    test('masks MRN/UHID identifiers', () => {
      const out = scrubPhiFromString('record MRN: 2026-00451 accessed');
      expect(out).not.toContain('2026-00451');
      expect(out).toContain('***451');
    });

    test('leaves non-PHI strings alone', () => {
      const line = 'request 200 OK in 35ms id=12345 uid=550e8400-e29b-41d4-a716-446655440000';
      expect(scrubPhiFromString(line)).toBe(line);
    });
  });

  describe('scrubPhiDeep', () => {
    test('scrubs nested metadata without mutating the original', () => {
      const meta = {
        patient: { phone: '+919876543210', note: 'call 9876501234 after 5' },
        list: ['email someone@example.org'],
      };
      const out = scrubPhiDeep(meta);
      expect(JSON.stringify(out)).not.toContain('9876543210');
      expect(JSON.stringify(out)).not.toContain('9876501234');
      expect(JSON.stringify(out)).not.toContain('someone@example.org');
      // original untouched
      expect(meta.patient.phone).toBe('+919876543210');
    });

    test('handles circular structures without throwing', () => {
      const a = { phone: '+919876543210' };
      a.self = a;
      expect(() => scrubPhiDeep(a)).not.toThrow();
    });
  });

  describe('phiRedactionFormat (wired into the logger)', () => {
    test('scrubs message, stack, and meta on a log record', () => {
      const fmt = phiRedactionFormat();
      const info = fmt.transform({
        level: 'info',
        message: 'Reminder sent to +919876543210',
        stack: 'Error at sendTo(+919876543210)',
        patient: { phone: '9876543210', email: 'a.b@example.com' },
      });
      expect(info.message).not.toContain('+919876543210');
      expect(info.stack).not.toContain('+919876543210');
      expect(JSON.stringify(info.patient)).not.toContain('9876543210');
      expect(JSON.stringify(info.patient)).not.toContain('a.b@example.com');
    });
  });

  describe('grep sweep — no raw phone interpolation in logger calls', () => {
    test('no logger call interpolates an unmasked *phone* variable', () => {
      const offenders = [];
      const phoneInterp = /logger\.(info|warn|error|debug)\([^\n]*\$\{(?![^}]*maskPhoneForLog)[A-Za-z0-9_.?]*[pP]hone(?!s\b)[A-Za-z0-9_]*\}/;

      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (['node_modules', 'tests', 'logs'].includes(entry.name)) continue;
            walk(full);
          } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
            const lines = fs.readFileSync(full, 'utf8').split('\n');
            lines.forEach((line, i) => {
              if (phoneInterp.test(line)) {
                offenders.push(`${path.relative(SRC_DIR, full)}:${i + 1}`);
              }
            });
          }
        }
      };
      walk(SRC_DIR);

      expect(offenders).toEqual([]);
    });
  });
});
