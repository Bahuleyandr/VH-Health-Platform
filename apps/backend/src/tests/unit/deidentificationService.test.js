import { jest } from '@jest/globals';
// Pure module — but it imports prisma for a later task, so mock it now.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { users: { findUnique: jest.fn() } },
  prismaReadOnly: { users: { findUnique: jest.fn() } },
}));
const { deidentifyText } = await import('../../services/ai/deidentificationService.js');

test('redacts chart-anchored known identifiers by exact value (NAME, PHONE)', () => {
  const out = deidentifyText('Ramesh Kumar (98765 43210) seen in clinic.', {
    knownIdentifiers: [
      { value: 'Ramesh Kumar', category: 'NAME' },
      { value: '98765 43210', category: 'PHONE' },
    ],
  });
  expect(out.text).toBe('[REDACTED:NAME] ([REDACTED:PHONE]) seen in clinic.');
  expect(out.redactions).toEqual(expect.arrayContaining([
    { category: 'NAME', count: 1 }, { category: 'PHONE', count: 1 },
  ]));
});

test('redacts longest known value first so a surname does not leak as a partial', () => {
  const out = deidentifyText('Kumar; full name Ramesh Kumar.', {
    knownIdentifiers: [
      { value: 'Kumar', category: 'NAME' },
      { value: 'Ramesh Kumar', category: 'NAME' },
    ],
  });
  expect(out.text).not.toContain('Kumar');
  expect(out.text).toBe('[REDACTED:NAME]; full name [REDACTED:NAME].');
});

test('regex-sweeps structured identifiers of anyone (email, Aadhaar, UID)', () => {
  const out = deidentifyText('contact kin@example.com, aadhaar 1234 5678 9012, id 9f8e7d6c-1234-4abc-89ab-0123456789ab', {});
  expect(out.text).toContain('[REDACTED:EMAIL]');
  expect(out.text).toContain('[REDACTED:AADHAAR]');
  expect(out.text).toContain('[REDACTED:UID]');
  expect(out.text).not.toContain('kin@example.com');
});

test('redacts ages >= 90 but leaves younger ages', () => {
  const out = deidentifyText('A 92 year old man; his 45 year old son.', {});
  expect(out.text).toContain('[REDACTED:AGE]');
  expect(out.text).toContain('45 year old');
});

test('flags residual identifier-shaped tokens and absolute dates without auto-redacting dates', () => {
  const out = deidentifyText('Admitted 12/06/2026. Ph 99887 76655.', {});
  expect(out.text).toContain('12/06/2026');
  expect(out.residualFlags.some((f) => f.code === 'RESIDUAL_DATE')).toBe(true);
  expect(out.text).toContain('[REDACTED:PHONE]');
});

test('fail-closed: an internal error returns empty text + DEID_FAILED, never the original', () => {
  const evil = { category: 'NAME', get value() { throw new Error('boom'); } };
  const out = deidentifyText('secret PHI here', { knownIdentifiers: [evil] });
  expect(out.text).toBe('');
  expect(out.text).not.toContain('secret PHI here');
  expect(out.residualFlags.some((f) => f.code === 'DEID_FAILED' && f.severity === 'critical')).toBe(true);
});
