// WP4 — OTC counter-sale drug-KB advisory (fail-OPEN by design decision).
// Pins the hard constraint: the advisory can NEVER block or throw into the
// sale path — gates off ⇒ null (response byte-identical), engine error ⇒
// null + warn, audit-write error ⇒ advisory still returned. The fail-CLOSED
// prescription path (validatePrescriptionSafety) is a different surface and
// is not touched by this helper.
import { jest } from '@jest/globals';

const executeRawUnsafeMock = jest.fn();
const evaluateDrugKbMock = jest.fn();
const getDrugKbSettingsMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: executeRawUnsafeMock },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: loggerWarnMock, error: jest.fn(), debug: jest.fn(),
  },
}));
jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: evaluateDrugKbMock,
}));
jest.unstable_mockModule('../../services/clinical/drugKbLinkService.js', () => ({
  isDrugKbDeterministicEnvEnabled: () => process.env.DRUG_KB_DETERMINISTIC_MATCHING === 'true',
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getDrugKbSettings: getDrugKbSettingsMock,
}));
// Heavy sale-path collaborators — not exercised by the advisory helper.
jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  recordMovementTx: jest.fn(),
  dispenseControlledTx: jest.fn(),
  lockControlledRegisterItemTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_APPROVAL_SCOPES: { counterSale: 'counter_sale' },
  approveControlledDispenseWitnessApproval: jest.fn(),
  assertApprovedControlledDispenseWitness: jest.fn(),
  consumeControlledDispenseWitnessApproval: jest.fn(),
  createControlledDispenseWitnessApproval: jest.fn(),
  preflightControlledDispenseWitnessApproval: jest.fn(),
}));
jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  createDraftInvoice: jest.fn(),
  addInvoiceItem: jest.fn(),
  fiscalYearOf: jest.fn(),
  voidInvoice: jest.fn(),
  collectPayment: jest.fn(),
  raiseRefund: jest.fn(),
  approveRefund: jest.fn(),
  markRefundPaid: jest.fn(),
  getInvoice: jest.fn(),
  issueInvoiceTx: jest.fn(),
  deriveInvoicePaymentStateFromLedgerTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: jest.fn(),
}));
jest.unstable_mockModule('../../services/billing/ledger/ledgerPostings.js', () => ({
  postInvoiceIssueEntry: jest.fn(),
  postPaymentEntry: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  startWorkflowSla: jest.fn(),
}));

const { counterSaleDrugKbAdvisory } = await import('../../services/pharmacy/counterSaleService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SELLER = '22222222-2222-4222-8222-222222222222';

function itemsByIdOf(names) {
  return new Map(names.map((name, i) => [i + 1, { id: i + 1, display_name: name }]));
}

const FINDING = {
  check: 'interaction',
  severity: 'contraindicated',
  drug_keys: ['nitroglycerin', 'sildenafil'],
  medications: ['GTN 2.6', 'Viagra 50'],
  message: 'boom',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DRUG_KB_DETERMINISTIC_MATCHING;
  getDrugKbSettingsMock.mockResolvedValue({ deterministicMatching: false, counterSaleAdvisory: true });
  evaluateDrugKbMock.mockResolvedValue({ kbAvailable: true, findings: [FINDING] });
  executeRawUnsafeMock.mockResolvedValue(1);
});

afterAll(() => {
  delete process.env.DRUG_KB_DETERMINISTIC_MATCHING;
});

test('env gate off → null, engine never consulted (byte-identical response)', async () => {
  const advisory = await counterSaleDrugKbAdvisory({
    tenantId: TENANT, itemsById: itemsByIdOf(['GTN 2.6', 'Viagra 50']),
  });
  expect(advisory).toBeNull();
  expect(getDrugKbSettingsMock).not.toHaveBeenCalled();
  expect(evaluateDrugKbMock).not.toHaveBeenCalled();
});

test('tenant flag off → null even with env on', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  getDrugKbSettingsMock.mockResolvedValue({ deterministicMatching: true, counterSaleAdvisory: false });
  const advisory = await counterSaleDrugKbAdvisory({
    tenantId: TENANT, itemsById: itemsByIdOf(['GTN 2.6']),
  });
  expect(advisory).toBeNull();
  expect(evaluateDrugKbMock).not.toHaveBeenCalled();
});

test('both gates on → advisory with findings + audit evidence row', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  const advisory = await counterSaleDrugKbAdvisory({
    tenantId: TENANT,
    itemsById: itemsByIdOf(['GTN 2.6', 'Viagra 50']),
    saleId: '42',
    soldBy: SELLER,
  });
  expect(evaluateDrugKbMock).toHaveBeenCalledWith({
    medications: [{ name: 'GTN 2.6' }, { name: 'Viagra 50' }],
    tenantId: TENANT,
  });
  expect(advisory).toEqual({ kb_available: true, findings: [FINDING], count: 1 });
  expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
  const [sql, uid, saleId] = executeRawUnsafeMock.mock.calls[0];
  expect(sql).toMatch(/COUNTER_SALE_DRUG_KB_ADVISORY/);
  expect(uid).toBe(SELLER);
  expect(saleId).toBe('42');
});

test('no findings → advisory returned, no audit row', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  evaluateDrugKbMock.mockResolvedValue({ kbAvailable: true, findings: [] });
  const advisory = await counterSaleDrugKbAdvisory({
    tenantId: TENANT, itemsById: itemsByIdOf(['Paracetamol 500']),
  });
  expect(advisory).toEqual({ kb_available: true, findings: [], count: 0 });
  expect(executeRawUnsafeMock).not.toHaveBeenCalled();
});

test('NEVER BLOCKS: engine error is swallowed and logged, returns null', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  evaluateDrugKbMock.mockRejectedValue(new Error('KB exploded'));
  await expect(counterSaleDrugKbAdvisory({
    tenantId: TENANT, itemsById: itemsByIdOf(['GTN 2.6']),
  })).resolves.toBeNull();
  expect(loggerWarnMock).toHaveBeenCalledWith(
    expect.stringContaining('advisory failed (non-blocking)'),
    expect.objectContaining({ error: 'KB exploded' }),
  );
});

test('NEVER BLOCKS: settings-read error is swallowed, returns null', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  getDrugKbSettingsMock.mockRejectedValue(new Error('tenant cache down'));
  await expect(counterSaleDrugKbAdvisory({
    tenantId: TENANT, itemsById: itemsByIdOf(['GTN 2.6']),
  })).resolves.toBeNull();
  expect(loggerWarnMock).toHaveBeenCalled();
});

test('NEVER BLOCKS: audit-write failure still returns the advisory', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  executeRawUnsafeMock.mockRejectedValue(new Error('audit insert failed'));
  const advisory = await counterSaleDrugKbAdvisory({
    tenantId: TENANT, itemsById: itemsByIdOf(['GTN 2.6', 'Viagra 50']), saleId: '7',
  });
  expect(advisory).toEqual({ kb_available: true, findings: [FINDING], count: 1 });
  expect(loggerWarnMock).toHaveBeenCalledWith(
    expect.stringContaining('audit write failed'),
    expect.objectContaining({ sale_id: '7' }),
  );
});

test('empty/missing items → null without consulting the engine', async () => {
  process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  await expect(counterSaleDrugKbAdvisory({ tenantId: TENANT, itemsById: new Map() }))
    .resolves.toBeNull();
  await expect(counterSaleDrugKbAdvisory({ tenantId: TENANT, itemsById: null }))
    .resolves.toBeNull();
  expect(evaluateDrugKbMock).not.toHaveBeenCalled();
});
