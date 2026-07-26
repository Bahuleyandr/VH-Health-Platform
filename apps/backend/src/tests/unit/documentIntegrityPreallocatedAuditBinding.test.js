import { jest } from '@jest/globals';

const prismaMock = { $queryRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  isTenantTransactionClient: (value) => value?.__tenantTransaction === true,
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({ recordCanonicalClinicalEvent: jest.fn() }),
);

const { signDocumentTx } = await import(
  '../../services/clinical/documentIntegrityService.js'
);

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const ACTOR_UID = '30000000-0000-4000-8000-000000000001';
const ACTION_ID = '40000000-0000-4000-8000-000000000001';
const SIGNATURE_ID = '50000000-0000-4000-8000-000000000001';
const AUDIT_ID = '60000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '70000000-0000-4000-8000-000000000001';

function documentRow() {
  return {
    doc: {
      id: ACTION_ID,
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
      action_kind: 'discharge_owner_cross_sign',
    },
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
  };
}

function signatureRow() {
  return {
    id: SIGNATURE_ID,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    document_type: 'diagnostic_result_action',
    document_table: 'diagnostic_result_actions',
    document_id: ACTION_ID,
    audit_event_id: AUDIT_ID,
  };
}

function input(overrides = {}) {
  return {
    documentType: 'diagnostic_result_action',
    documentId: ACTION_ID,
    signatureId: SIGNATURE_ID,
    canonicalAuditEventId: AUDIT_ID,
    ...overrides,
  };
}

function context() {
  return {
    actorUid: ACTOR_UID,
    actorRole: 'DOCTOR',
    actorName: 'Dr Test',
  };
}

function tenantTx(handler) {
  return {
    __tenantTransaction: true,
    $queryRawUnsafe: jest.fn(handler),
  };
}

describe('preallocated signature audit resource binding', () => {
  it('keeps the signed document table and id as the strict default', async () => {
    const tx = tenantTx(async (sql, ...params) => {
      if (sql.includes('to_jsonb(t)')) return [documentRow()];
      if (sql.includes('FROM clinical_audit_events')) {
        expect(params).toEqual([
          AUDIT_ID,
          TENANT_ID,
          PATIENT_UID,
          'diagnostic_result_actions',
          ACTION_ID,
        ]);
        return [{ id: AUDIT_ID }];
      }
      if (sql.includes('INSERT INTO clinical_document_signatures')) {
        return [signatureRow()];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(signDocumentTx(
      input(),
      context(),
      { tx },
    )).resolves.toMatchObject(signatureRow());
  });

  it.each([
    ['table only', {
      canonicalAuditResourceTable: 'discharge_pending_result_handoffs',
    }],
    ['id only', { canonicalAuditResourceId: HANDOFF_ID }],
  ])('rejects a partial %s override before reading the document', async (
    _label,
    override,
  ) => {
    const tx = tenantTx();

    await expect(signDocumentTx(
      input(override),
      context(),
      { tx },
    )).rejects.toMatchObject({
      code: 'SIGN_PREALLOCATED_AUDIT_BINDING_INCOMPLETE',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('accepts one exact server-supplied alternate audit resource binding', async () => {
    const tx = tenantTx(async (sql, ...params) => {
      if (sql.includes('to_jsonb(t)')) return [documentRow()];
      if (sql.includes('FROM clinical_audit_events')) {
        expect(params).toEqual([
          AUDIT_ID,
          TENANT_ID,
          PATIENT_UID,
          'discharge_pending_result_handoffs',
          HANDOFF_ID,
        ]);
        return [{ id: AUDIT_ID }];
      }
      if (sql.includes('INSERT INTO clinical_document_signatures')) {
        return [signatureRow()];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(signDocumentTx(
      input({
        canonicalAuditResourceTable: 'discharge_pending_result_handoffs',
        canonicalAuditResourceId: HANDOFF_ID,
      }),
      context(),
      { tx },
    )).resolves.toMatchObject(signatureRow());
  });

  it('fails closed when the exact alternate audit resource is unavailable', async () => {
    const tx = tenantTx(async (sql) => {
      if (sql.includes('to_jsonb(t)')) return [documentRow()];
      if (sql.includes('FROM clinical_audit_events')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(signDocumentTx(
      input({
        canonicalAuditResourceTable: 'discharge_pending_result_handoffs',
        canonicalAuditResourceId: HANDOFF_ID,
      }),
      context(),
      { tx },
    )).rejects.toMatchObject({ code: 'SIGN_CANONICAL_AUDIT_REQUIRED' });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
