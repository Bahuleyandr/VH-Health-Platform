import { jest } from '@jest/globals';

const resolvePathwayModeTxMock = jest.fn();

jest.unstable_mockModule(
  '../../services/pathways/pathwayRuntimePersistence.js',
  () => ({
    resolvePathwayModeTx: resolvePathwayModeTxMock,
  }),
);

const {
  validateEdHandoffAdmissionSourceTx,
  validateOpTransferAdmissionSourceTx,
} = await import('../../services/emr/inpatientAdmissionSourceValidation.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '30000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '40000000-0000-4000-8000-000000000001';
const RECIPIENT_UID = '50000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
});

function activeAdvisedTx({ accepted = true } = {}) {
  return {
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (sql.includes('FROM appointments AS appointment')) return [{ id: 73 }];
      if (sql.includes('FROM care_pathway_instances AS pathway')
          && !sql.includes('JOIN care_pathway_instances AS pathway')) {
        return [{ id: PATHWAY_ID }];
      }
      if (sql.includes('FROM care_handoff_instances AS handoff')) {
        return accepted ? [{ accepted_by_uid: RECIPIENT_UID }] : [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
}

describe('active OP advice admission source validation', () => {
  it('blocks omission of the exact accepted transfer for a live active OP episode', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('active');
    const tx = activeAdvisedTx();

    await expect(validateOpTransferAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: 73,
    })).rejects.toMatchObject({
      code: 'INPATIENT_SOURCE_TRANSFER_REQUIRED',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('accepts only the exact live pathway and accepted handoff tuple', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('active');
    const tx = activeAdvisedTx();

    await expect(validateOpTransferAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: 73,
      sourcePathwayInstanceId: PATHWAY_ID,
      sourceHandoffId: HANDOFF_ID,
    })).resolves.toEqual({
      linkage_required: true,
      accepted_recipient_uid: RECIPIENT_UID,
      source_pathway_instance_id: PATHWAY_ID,
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$queryRawUnsafe.mock.calls[2].slice(1)).toEqual([
      TENANT_ID,
      HANDOFF_ID,
      PATIENT_UID,
      PATHWAY_ID,
      '73',
      'op_contact_to_recovery',
    ]);
  });

  it('does not change shadow-mode admission behavior when no tuple is supplied', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('shadow');
    const tx = activeAdvisedTx();

    await expect(validateOpTransferAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: 73,
    })).resolves.toEqual({
      linkage_required: false,
      accepted_recipient_uid: null,
      source_pathway_instance_id: null,
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('still rejects a supplied tuple that is not the exact accepted transfer', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('active');
    const tx = activeAdvisedTx({ accepted: false });

    await expect(validateOpTransferAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: 73,
      sourcePathwayInstanceId: PATHWAY_ID,
      sourceHandoffId: HANDOFF_ID,
    })).rejects.toMatchObject({
      code: 'INPATIENT_SOURCE_TRANSFER_INVALID',
    });
  });
});

describe('active ED admission source validation', () => {
  function activeEdTx({ accepted = true } = {}) {
    return {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (
          sql.includes('FROM care_pathway_instances AS pathway')
          && !sql.includes('JOIN care_pathway_instances AS pathway')
        ) {
          return [{ id: PATHWAY_ID }];
        }
        if (sql.includes('FROM care_handoff_instances AS handoff')) {
          return accepted ? [{ id: HANDOFF_ID }] : [];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
  }

  it('requires the exact accepted ED handoff for a live active visit', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('active');
    const tx = activeEdTx();

    await expect(validateEdHandoffAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      emergencyVisitId: 73,
    })).rejects.toMatchObject({
      code: 'ED_ADMISSION_SOURCE_HANDOFF_REQUIRED',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('rechecks active role and completed no-SLA task evidence on the exact tuple', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('active');
    const tx = activeEdTx();

    await expect(validateEdHandoffAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      emergencyVisitId: 73,
      sourcePathwayInstanceId: PATHWAY_ID,
      sourceHandoffId: HANDOFF_ID,
    })).resolves.toEqual({
      linkage_required: true,
      source_pathway_instance_id: PATHWAY_ID,
    });
    const sql = tx.$queryRawUnsafe.mock.calls[1][0];
    for (const contract of [
      'JOIN tasks AS task',
      "task.task_kind = 'ed_destination_handoff_review'",
      "task.status = 'completed'",
      'task.assigned_to_role = handoff.intended_recipient_role',
      'task.due_at IS NULL',
      'task.workflow_sla_instance_id IS NULL',
      "task.sla_completion_semantics = 'none'",
      'handoff.intended_recipient_role = UPPER(BTRIM(accepter.role))',
    ]) {
      expect(sql).toContain(contract);
    }
    expect(tx.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual([
      TENANT_ID,
      HANDOFF_ID,
      PATIENT_UID,
      PATHWAY_ID,
      73,
      'emergency_arrival_to_aftercare',
    ]);
  });

  it('keeps off and shadow admission behavior unchanged without a supplied tuple', async () => {
    resolvePathwayModeTxMock.mockResolvedValue('shadow');
    const tx = activeEdTx();

    await expect(validateEdHandoffAdmissionSourceTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      emergencyVisitId: 73,
    })).resolves.toEqual({
      linkage_required: false,
      source_pathway_instance_id: null,
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
