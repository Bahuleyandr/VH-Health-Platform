import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

const consumeMarSupplyTxMock = jest.fn();
const assertMedicationOrdersExecutionReadyTxMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/marSupplyService.js', () => ({
  assertMedicationOrdersExecutionReadyTx: assertMedicationOrdersExecutionReadyTxMock,
  consumeMarSupplyTx: consumeMarSupplyTxMock,
}));

const {
  inspectMedicationAdministrationTx,
  MAR_ADMINISTRATION_MODES,
  recordMedicationAdministrationTx,
} = await import('../../services/clinical/marService.js');

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  checker: '10000000-0000-4000-8000-000000000002',
  encounter: '10000000-0000-4000-8000-000000000003',
  patient: '10000000-0000-4000-8000-000000000004',
  tenant: '10000000-0000-4000-8000-000000000005',
});

const OCCURRED_AT = '2026-07-31T03:00:00.000Z';

function createTx({
  admission = true,
  status = 'scheduled',
  witness = true,
  sibling = null,
  updateError = null,
} = {}) {
  const query = jest.fn(async (sql) => {
    if (sql.includes('SELECT clinical_order_id') && sql.includes('LIMIT 1')) {
      return [{ clinical_order_id: 91 }];
    }
    if (sql.includes('FROM medication_administrations') && sql.includes('FOR UPDATE')) {
      return [{
        id: 42,
        patient_uid: IDS.patient,
        medication_name: 'Paper medication',
        scheduled_time: OCCURRED_AT,
        administered_at: status === 'administered' ? OCCURRED_AT : null,
        administered_by: status === 'administered' ? IDS.actor : null,
        status,
        witness_uid: status === 'administered' ? IDS.checker : null,
        tenant_id: IDS.tenant,
        clinical_order_id: 91,
      }];
    }
    if (sql.includes('FROM admissions')) {
      return admission ? [{ id: 41, patient_uid: IDS.patient, encounter_id: IDS.encounter }] : [];
    }
    if (sql.includes('FROM users')) {
      return witness ? [{ uid: IDS.checker, role: 'NURSING_STAFF' }] : [];
    }
    if (sql.includes('FROM medication_administrations')) {
      return sibling ? [{ id: sibling }] : [];
    }
    if (sql.includes('UPDATE medication_administrations')) {
      if (updateError) throw updateError;
      return [{
        id: 42,
        patient_uid: IDS.patient,
        medication_name: 'Paper medication',
        scheduled_time: OCCURRED_AT,
        administered_at: OCCURRED_AT,
        administered_by: IDS.actor,
        status: 'administered',
        witness_uid: IDS.checker,
        override_reason: null,
        tenant_id: IDS.tenant,
        patient_scanned_at: null,
        medication_scanned_at: null,
      }];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  });
  return { $queryRawUnsafe: query };
}

function paperInput(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    medicationAdministrationId: 42,
    administeredBy: IDS.actor,
    notes: 'Signed MAR paper entry',
    witnessUid: IDS.checker,
    witnessRole: 'NURSING_STAFF',
    occurredAt: OCCURRED_AT,
    expectedPatientUid: IDS.patient,
    expectedAdmissionId: 41,
    expectedEncounterId: IDS.encounter,
    mode: MAR_ADMINISTRATION_MODES.RETROSPECTIVE_PAPER_BACK_ENTRY,
    ...overrides,
  };
}

describe('shared MAR administration transaction core', () => {
  beforeEach(() => {
    assertMedicationOrdersExecutionReadyTxMock.mockReset();
    assertMedicationOrdersExecutionReadyTxMock.mockResolvedValue([{ id: 91 }]);
    consumeMarSupplyTxMock.mockReset();
    consumeMarSupplyTxMock.mockResolvedValue({ status: 'matched', quantity: 1 });
  });

  test('applies a paper fact with exact admission, checker, occurrence, and no electronic override', async () => {
    const tx = createTx();
    const input = paperInput();
    const inspection = await inspectMedicationAdministrationTx(tx, input);
    expect(inspection).toMatchObject({ disposition: 'apply' });

    const result = await recordMedicationAdministrationTx(tx, { ...input, inspection });
    expect(result).toMatchObject({
      disposition: 'recorded',
      previousStatus: 'scheduled',
      record: {
        administered_at: OCCURRED_AT,
        status: 'administered',
        witness_uid: IDS.checker,
        override_reason: null,
        patient_scanned_at: null,
        medication_scanned_at: null,
        supply_state: { status: 'matched', quantity: 1 },
      },
    });
    expect(consumeMarSupplyTxMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      tenantId: IDS.tenant,
      administration: inspection.row,
      recordedBy: IDS.actor,
      administrationMode: MAR_ADMINISTRATION_MODES.RETROSPECTIVE_PAPER_BACK_ENTRY,
    }));

    const updateCall = tx.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('UPDATE medication_administrations'));
    expect(updateCall[0]).toContain("lower(status) = 'scheduled'");
    expect(updateCall[0]).not.toContain("'due'");
    expect(updateCall[0]).not.toContain("'pending'");
    expect(updateCall.slice(1)).toEqual([
      OCCURRED_AT,
      IDS.actor,
      'Signed MAR paper entry',
      IDS.checker,
      null,
      IDS.tenant,
      42,
    ]);
  });

  test.each([
    ['due', 'MAR_STATE_CONFLICT'],
    ['pending', 'MAR_STATE_CONFLICT'],
    ['held', 'MAR_HOLD_RELEASE_REQUIRED'],
    ['administered', null],
  ])('does not broaden canonical source state %s', async (status, expectedCode) => {
    const tx = createTx({ status });
    const inspection = await inspectMedicationAdministrationTx(tx, paperInput());
    if (status === 'administered') {
      expect(inspection).toMatchObject({ disposition: 'exact_projection' });
    } else {
      expect(inspection).toMatchObject({ disposition: 'conflict', code: expectedCode });
    }
    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('UPDATE medication_administrations'))).toBe(false);
  });

  test.each([
    [{ admission: false }, 'MAR_ADMISSION_MISMATCH'],
    [{ witness: false }, 'MAR_WITNESS_NOT_AUTHORIZED'],
    [{ sibling: 77 }, 'MAR_DUPLICATE_ADMINISTRATION'],
  ])('fails closed when the paper safety context is invalid', async (txOptions, code) => {
    const inspection = await inspectMedicationAdministrationTx(createTx(txOptions), paperInput());
    expect(inspection).toMatchObject({ disposition: 'conflict', code });
  });

  test('maps the migration-327 uniqueness race to MAR_DUPLICATE_ADMINISTRATION', async () => {
    const tx = createTx({ updateError: Object.assign(new Error('duplicate key value'), { meta: { code: '23505' } }) });
    const input = paperInput();
    const inspection = await inspectMedicationAdministrationTx(tx, input);
    await expect(recordMedicationAdministrationTx(tx, { ...input, inspection })).rejects.toMatchObject({
      code: 'MAR_DUPLICATE_ADMINISTRATION',
      statusCode: 409,
    });
  });

  test('keeps the reconciliation service free of a direct medication-administration UPDATE', () => {
    const source = readFileSync(
      new URL('../../services/downtime/clinicalContinuityReconciliationService.js', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/UPDATE\s+medication_administrations/i);
    expect(source).toContain('recordMedicationAdministrationTx');
  });
});
