import { jest } from '@jest/globals';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  prismaReadOnly: { $queryRawUnsafe: jest.fn() },
}));
const prismaMod = await import('../../lib/prisma.js');
const { __testing__ } = await import('../../services/ai/clinicianEhrQueryService.js');
const { serializeEhrContext, resolveCurrentAdmission } = __testing__;

test('serializeEhrContext labels both sections and flattens citations', () => {
  const out = serializeEhrContext({
    currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: '2026-06-10T00:00:00Z', type: 'lab', summary: 'Creatinine 2.1', citation: { id: 'c1' } }] },
    history: [{ timestamp: '2024-03-01T00:00:00Z', type: 'lab', summary: 'Creatinine 0.9', citation: { id: 'c2' } }],
    scope: 'both',
  });
  expect(out.text).toContain('[CURRENT ADMISSION]');
  expect(out.text).toContain('Creatinine 2.1');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.text).toContain('Creatinine 0.9');
  expect(out.citations.map((c) => c.id)).toEqual(['c1', 'c2']);
});

test('serializeEhrContext with scope=current_admission omits history', () => {
  const out = serializeEhrContext({ currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: 't', type: 'note', summary: 'x' }] }, history: [{ timestamp: 't2', type: 'note', summary: 'y' }], scope: 'current_admission' });
  expect(out.text).toContain('[CURRENT ADMISSION]');
  expect(out.text).not.toContain('[PRIOR HISTORY]');
  expect(out.text).not.toContain('y');
});

test('serializeEhrContext with scope=history omits the current-admission section', () => {
  const out = serializeEhrContext({ currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: 't', type: 'note', summary: 'admitnote' }] }, history: [{ timestamp: 't2', type: 'note', summary: 'historynote' }], scope: 'history' });
  expect(out.text).not.toContain('[CURRENT ADMISSION]');
  expect(out.text).not.toContain('admitnote');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.text).toContain('historynote');
});

test('serializeEhrContext handles a null currentAdmission (outpatient) gracefully', () => {
  const out = serializeEhrContext({ currentAdmission: null, history: [{ timestamp: 't2', type: 'note', summary: 'historynote', citation: { id: 'c9' } }], scope: 'both' });
  expect(out.text).not.toContain('[CURRENT ADMISSION]');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.citations.map((c) => c.id)).toEqual(['c9']);
});

test('resolveCurrentAdmission returns the active admission id or null', async () => {
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([{ id: 42 }]);
  await expect(resolveCurrentAdmission('p1', 't1')).resolves.toBe(42);
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([]);
  await expect(resolveCurrentAdmission('p1', 't1')).resolves.toBeNull();
});
