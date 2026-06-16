import { jest } from '@jest/globals';
// Pure module — but it imports prisma for a later task, so mock it now.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { users: { findUnique: jest.fn() } },
  prismaReadOnly: { users: { findUnique: jest.fn() } },
}));
const { deidentifyText, collectKnownIdentifiers } = await import('../../services/ai/deidentificationService.js');
const prismaMod = await import('../../lib/prisma.js');

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

test('does not over-redact a known name embedded inside a larger word', () => {
  const out = deidentifyText('Ann reviewed the announcement and Ann signed.', {
    knownIdentifiers: [{ value: 'Ann', category: 'NAME' }],
  });
  // standalone "Ann" redacted twice; "announcement" left intact (no substring leak-of-utility).
  expect(out.text).toBe('[REDACTED:NAME] reviewed the announcement and [REDACTED:NAME] signed.');
  expect(out.redactions).toEqual([{ category: 'NAME', count: 2 }]);
});

test('still redacts a known value whose edges are non-word chars (no under-redaction regression)', () => {
  const out = deidentifyText('Call +91 98765-43210 now.', {
    knownIdentifiers: [{ value: '+91 98765-43210', category: 'PHONE' }],
  });
  expect(out.text).toContain('[REDACTED:PHONE]');
  expect(out.text).not.toContain('98765');
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

test('pseudonymize mode emits a STABLE per-value token (same value+salt -> same token)', () => {
  const ids = [{ value: 'Ramesh Kumar', category: 'NAME' }];
  const a = deidentifyText('Ramesh Kumar today; Ramesh Kumar again.', { knownIdentifiers: ids, mode: 'pseudonymize', salt: 's1' });
  const tokens = a.text.match(/\[NAME-[0-9a-f]{8}\]/g);
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBe(tokens[1]); // co-reference preserved
  expect(a.text).not.toContain('[REDACTED:NAME]');
});

test('pseudonymize is salt-dependent: a different salt yields a different token', () => {
  const ids = [{ value: 'Ramesh Kumar', category: 'NAME' }];
  const a = deidentifyText('Ramesh Kumar', { knownIdentifiers: ids, mode: 'pseudonymize', salt: 's1' });
  const b = deidentifyText('Ramesh Kumar', { knownIdentifiers: ids, mode: 'pseudonymize', salt: 's2' });
  expect(a.text).not.toBe(b.text);
});

test('fail-closed: an internal error returns empty text + DEID_FAILED, never the original', () => {
  const evil = { category: 'NAME', get value() { throw new Error('boom'); } };
  const out = deidentifyText('secret PHI here', { knownIdentifiers: [evil] });
  expect(out.text).toBe('');
  expect(out.text).not.toContain('secret PHI here');
  expect(out.residualFlags.some((f) => f.code === 'DEID_FAILED' && f.severity === 'critical')).toBe(true);
});

test('collectKnownIdentifiers assembles patient + next-of-kin identifiers, skipping blanks', async () => {
  prismaMod.default.users.findUnique.mockResolvedValueOnce({
    name: 'Ramesh Kumar', phone: '9876543210', email: 'ramesh@example.com',
    birthday: new Date('1990-06-12T00:00:00Z'), address: '12 MG Road, Chennai',
    emergency_contact: { name: 'Sita Kumar', phone: '9000000000' },
  });
  const ids = await collectKnownIdentifiers('pat-uuid', { tenantId: 't1' });
  const byCat = (c) => ids.filter((i) => i.category === c).map((i) => i.value);
  expect(byCat('NAME')).toEqual(expect.arrayContaining(['Ramesh Kumar', 'Sita Kumar']));
  expect(byCat('PHONE')).toEqual(expect.arrayContaining(['9876543210', '9000000000']));
  expect(byCat('EMAIL')).toEqual(['ramesh@example.com']);
  expect(byCat('ADDRESS')).toEqual(['12 MG Road, Chennai']);
  // DOB expanded into common string renderings so it can be matched in free text.
  expect(byCat('DOB').some((v) => v.includes('1990'))).toBe(true);
});

test('collectKnownIdentifiers returns [] when the patient is not found', async () => {
  prismaMod.default.users.findUnique.mockResolvedValueOnce(null);
  await expect(collectKnownIdentifiers('missing', { tenantId: 't1' })).resolves.toEqual([]);
});
