import { jest } from '@jest/globals';

// Mirror the proven import setup from clinicalAiModuleSeedConcurrency.test.js so
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

test('clinical_text_deidentifier is registered, disabled, governance/critical', () => {
  const m = CLINICAL_AI_MODULES.find((x) => x.module_key === 'clinical_text_deidentifier');
  expect(m).toBeDefined();
  expect(m.enabled).toBe(false);
  expect(m.settings.surface).toBe('governance');
  expect(m.settings.risk).toBe('critical');
  expect(m.settings.requiresCitations).toBe(false);
  expect(m.settings.outputSchema.required).toEqual(expect.arrayContaining(['text', 'redactions']));
});
