import { jest } from '@jest/globals';

// Mirror the proven import setup from deidModuleRegistration.test.js so
// loading the module service (which imports prisma + logger at module load)
// works in a DB-free unit run. We only read the static CLINICAL_AI_MODULES array.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn(), $transaction: jest.fn() },
  setTenantTx: async (_t, fn) => fn({}),
  setTenant: async (_t, fn) => fn({}),
  runTenantScopedTransaction: async (_c, _g, fn) => fn({}),
  pickTenantClient: () => ({}),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { CLINICAL_AI_MODULES } = await import('../../services/ai/clinicalAiModuleService.js');

test('patient_triage is registered, disabled by default, patient-surface, high risk, retrospective review', () => {
  const m = CLINICAL_AI_MODULES.find((x) => x.module_key === 'patient_triage');
  expect(m).toBeDefined();
  // Patient-surface modules ship disabled; enablement is an explicit admin action.
  expect(m.enabled).toBe(false);
  expect(m.settings.surface).toBe('patient');
  expect(m.settings.risk).toBe('high');
  expect(m.settings.patientFacing).toBe(true);
  expect(m.settings.decisionSupportOnly).toBe(true);
  // Real-time patient-facing surface: retrospective review, never pre-response
  // signoff (same posture as patient_record_chatbot).
  expect(m.settings.requiresClinicianSignoff).toBe(false);
  expect(m.settings.reviewRoles).toEqual(['DOCTOR', 'ADMIN']);
  expect(m.settings.outputSchema.required).toEqual(
    expect.arrayContaining(['triage', 'differential', 'summary', 'redFlags']),
  );
});
