// Unit tests for pharmacyCapService — the pure pieces. The DB-touching
// probePharmacyCap is covered by the dispense integration suite.
//
// Regression for 2026-05-09-tpa-insurance-claim-billing-pharmacy-cap-not-enforced.

import { jest } from '@jest/globals';

import {
  assertPharmacyCapForDispenseTx,
  extractPharmacyCapFromRaw,
  lockCounterFundingSubstitutionAuthorityTx,
  resolveAuthoritativeCounterFundingTx,
  shouldBlockDispense,
  PHARMACY_CAP_CRITICAL_PCT,
  PHARMACY_CAP_WARN_PCT,
} from '../../services/pharmacy/pharmacyCapService.js';
import { clinicalOrderItemsSha256 } from '../../services/pharmacy/pharmacistVerificationService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const ITEMS = [{ catalog_id: 7, quantity: 1, unit_price: 75 }];
const ITEMS_SHA256 = clinicalOrderItemsSha256(ITEMS);
const COMMAND_SHA256 = 'a'.repeat(64);

function counterFundingArgs(overrides = {}) {
  return {
    tenantId: TENANT,
    patientId: 91,
    orderId: 71,
    paymentMode: 'cash',
    totalAmount: 75,
    orderVersion: 3,
    orderItemsSha256: ITEMS_SHA256,
    ...overrides,
  };
}

function capTx({ cap = 100, rawCap = null, spend = 50 } = {}) {
  const query = jest.fn(async (sql) => {
    if (sql.includes('SELECT patient.uid')) return [{ uid: PATIENT_UID }];
    if (sql.includes('pg_advisory_xact_lock')) return [{}];
    if (sql.includes('SELECT id,uid') && sql.includes('FROM users')) {
      return [{ id: 91, uid: PATIENT_UID }];
    }
    if (sql.includes('FROM pharmacy_orders') && sql.includes('funding_admission_id')) {
      return [{
        id: 71,
        patient_id: 91,
        uid: PATIENT_UID,
        facility_id: 7,
        status: 'READY',
        inventory_authority_version: 3,
        items_list: ITEMS,
        funding_admission_id: 44,
        funding_admission_order_version: 3,
        funding_admission_items_sha256: ITEMS_SHA256,
      }];
    }
    if (sql.includes('FROM admissions')) {
      return [{ id: 44, tenant_id: TENANT, patient_uid: PATIENT_UID, status: 'admitted' }];
    }
    if (sql.includes('FROM insurance_claim_caps')) {
      return cap == null ? [] : [{ max_amount: cap }];
    }
    if (sql.includes('FROM insurance_preauth_responses')) {
      return rawCap == null ? [] : [{ raw_response: { pharmacy_cap: rawCap } }];
    }
    if (sql.includes('FROM billing_invoice_items')) return [{ spend }];
    if (sql.includes('COALESCE(SUM(reserved_amount)')) return [{ spend: 0 }];
    if (sql.includes('UPPER(role) AS role')) {
      return [{ uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' }];
    }
    if (sql.includes('SELECT uid FROM users')) return [{ uid: PATIENT_UID }];
    if (sql.includes('FROM tpa_claims')) return [{ id: 301 }];
    if (sql.includes('FROM pharmacy_cap_reservation_events')) return [];
    if (sql.includes('SELECT * FROM pharmacy_cap_reservations')) return [];
    if (sql.includes('INSERT INTO pharmacy_cap_reservations')) {
      return [{
        id: 501, tenant_id: TENANT, pharmacy_order_id: 71, admission_id: 44,
        facility_id: 7, reserved_amount: 75, authorised_funding_amount: 75,
        funding_source: 'tpa_claim', funding_reference: 'tpa:301',
        funding_tpa_claim_id: 301,
      }];
    }
    if (sql.includes('INSERT INTO pharmacy_cap_reservation_events')) return [{ id: 601 }];
    throw new Error(`Unexpected cap SQL: ${sql}`);
  });
  return { tx: { $queryRawUnsafe: query }, query };
}

describe('assertPharmacyCapForDispenseTx', () => {
  it('locks the active admission and blocks against the authoritative transaction amount', async () => {
    const { tx, query } = capTx();

    await expect(assertPharmacyCapForDispenseTx(tx, {
      tenantId: TENANT,
      patientId: 91,
      additionalAmount: 75,
      orderId: 71,
      fundingSource: 'tpa_claim',
      fundingReference: 'tpa:301',
      fundingTpaClaimId: 301,
      authorisedFundingAmount: 75,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TPA_PHARMACY_CAP_EXCEEDED',
      details: {
        cap_amount: 100,
        current_spend: 50,
        projected_total: 125,
        utilisation_pct: 125,
      },
    });

    expect(query.mock.calls.some(([sql]) => /pharmacy_orders[\s\S]*FOR UPDATE/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /admissions[\s\S]*FOR UPDATE/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /c\.id = \$3::int/.test(sql))).toBe(true);
  });

  it('uses the same locked amount but permits an explicitly authorised override', async () => {
    const { tx } = capTx();

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 75,
        allowOverride: true,
        orderId: 71,
        facilityId: 7,
        actorUid: ACTOR_UID,
        actorRole: 'PHARMACY_INCHARGE',
        commandKeySha256: COMMAND_SHA256,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
        authorisedFundingAmount: 75,
      },
    )).resolves.toMatchObject({
      level: 'critical',
      projectedTotal: 125,
    });
  });

  it('tenant-binds the raw preauthorisation fallback independently of RLS', async () => {
    const { tx, query } = capTx({ cap: null, rawCap: 200, spend: 20 });

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 10,
        orderId: 71,
        facilityId: 7,
        actorUid: ACTOR_UID,
        actorRole: 'PHARMACY_INCHARGE',
        commandKeySha256: COMMAND_SHA256,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
        authorisedFundingAmount: 10,
      },
    )).resolves.toMatchObject({ pharmacyCap: 200, projectedTotal: 30 });

    const fallbackCall = query.mock.calls.find(([sql]) => sql.includes('insurance_preauth_responses'));
    expect(fallbackCall[0]).toMatch(/c\.id = \$3::int/);
    expect(fallbackCall.slice(1)).toEqual([44, TENANT, 301, PATIENT_UID]);
  });

  it('hard-blocks any positive dispense against an authoritative zero cap', async () => {
    const { tx } = capTx({ cap: 0, spend: 0 });

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 0.01,
        orderId: 71,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
        authorisedFundingAmount: 0.01,
      },
    )).rejects.toMatchObject({
      code: 'TPA_PHARMACY_CAP_EXCEEDED',
      details: {
        cap_amount: 0,
        projected_total: 0.01,
        utilisation_pct: 100,
      },
    });
  });

  it('durably records even a zero-value cap reservation with exact custody identity', async () => {
    const { tx, query } = capTx({ cap: 0, spend: 0 });

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 0,
        orderId: 71,
        facilityId: 7,
        actorUid: ACTOR_UID,
        actorRole: 'PHARMACY_INCHARGE',
        commandKeySha256: COMMAND_SHA256,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
      },
    )).resolves.toMatchObject({
      hasCap: true,
      pharmacyCap: 0,
      projectedTotal: 0,
      level: 'ok',
    });

    const reservation = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO pharmacy_cap_reservations'));
    expect(reservation[0]).toMatch(/INSERT INTO pharmacy_cap_reservations/);
    expect(reservation.slice(1, 6)).toEqual([TENANT, 7, 71, 44, 0]);
  });
});

describe('resolveAuthoritativeCounterFundingTx', () => {
  it('rejects a caller shape that omits the exact current order tuple', async () => {
    await expect(resolveAuthoritativeCounterFundingTx(
      { $queryRawUnsafe: jest.fn() },
      { tenantId: TENANT, patientId: 91, orderId: 71, paymentMode: 'insurance' },
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'COUNTER_FUNDING_AUTHORITY_REQUIRED',
    });
  });

  it('blocks active substitution authority under the workflow gate before domain locks', async () => {
    const calls = [];
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        calls.push(normalized);
        if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
          return [{ uid: PATIENT_UID }];
        }
        if (normalized.includes('vh:pharmacy_funding_authority:')) return [{}];
        if (normalized.includes('vh:substitution-funding:order:')) return [{}];
        if (normalized.includes('FROM pharmacy_funding_commands')) return [];
        if (normalized.includes('FROM approvals')) return [];
        if (normalized.includes('related_resource_type=ANY($3::text[])')) {
          return [{
            id: 801,
            related_resource_type: 'pharmacy_patient_advance',
            status: 'open',
            metadata: { contract: 'pharmacy_substitution_funding_task_v1' },
          }];
        }
        throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
      }),
    };

    await expect(lockCounterFundingSubstitutionAuthorityTx(tx, {
      tenantId: TENANT,
      patientId: 91,
      orderId: 71,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT',
      details: {
        pharmacy_order_id: 71,
        task_ids: [801],
        next_action: 'complete_or_govern_release_of_substitution_funding_authority',
      },
    });

    const gateIndex = calls.findIndex((sql) => sql.includes('vh:substitution-funding:order:'));
    const commandIndex = calls.findIndex((sql) => sql.includes('FROM pharmacy_funding_commands'));
    const approvalIndex = calls.findIndex((sql) => sql.includes('FROM approvals'));
    const taskIndex = calls.findIndex((sql) => sql.includes('FROM tasks'));
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(gateIndex);
    expect(approvalIndex).toBeGreaterThan(commandIndex);
    expect(taskIndex).toBeGreaterThan(approvalIndex);
    expect(calls.some((sql) => sql.includes('FROM pharmacy_orders'))).toBe(false);
    expect(calls.some((sql) => sql.includes('FROM billing_invoices'))).toBe(false);
    expect(calls.some((sql) => sql.includes('FROM billing_invoice_items'))).toBe(false);
  });

  it('does not surface a newer substitution task as generic recovery', async () => {
    const substitutionTask = {
      task_id: 802,
      status: 'open',
      assigned_to_role: 'FINANCE_INCHARGE',
      metadata: { contract: 'pharmacy_substitution_funding_task_v1' },
      invoice_item_id: 31,
    };
    let recoverySql = '';
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql, ...params) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
          return [{ uid: PATIENT_UID }];
        }
        if (normalized.includes('vh:pharmacy_funding_authority:')) return [{}];
        if (normalized.includes('vh:substitution-funding:order:')) return [{}];
        if (normalized.includes('FROM pharmacy_funding_commands')) return [];
        if (normalized.includes('FROM approvals')) return [];
        if (normalized.includes('related_resource_type=ANY($3::text[])')) return [];
        if (normalized.includes('vh:pharmacy_funding_event_chain:')) return [{}];
        if (normalized.startsWith('SELECT id,patient_id,status FROM pharmacy_orders')) {
          return [{ id: 71, patient_id: 91, status: 'READY' }];
        }
        if (normalized.includes('FROM pharmacy_funding_decision_events event')) return [];
        if (normalized.startsWith('SELECT task.id AS task_id,task.status')) {
          recoverySql = normalized;
          return params[2] === substitutionTask.metadata.contract ? [substitutionTask] : [];
        }
        throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
      }),
    };

    const substitutionFundingAuthorityLease = await lockCounterFundingSubstitutionAuthorityTx(
      tx,
      { tenantId: TENANT, patientId: 91, orderId: 71 },
    );
    await expect(resolveAuthoritativeCounterFundingTx(tx, counterFundingArgs({
      substitutionFundingAuthorityLease,
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
      details: {
        next_action: 'materialize_pharmacy_funding',
        funding_recovery: null,
      },
    });

    expect(recoverySql).toContain("task.metadata->>'contract'=$3");
    expect(recoverySql).toContain("task.metadata->>'task_type'='posted_payment'");
    expect(recoverySql).not.toContain("'pharmacy_patient_advance'");
  });

  it('keeps a completed TPA-only approval blocked until exact consumption or release', async () => {
    const proposalSha256 = 'a'.repeat(64);
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
          return [{ uid: PATIENT_UID }];
        }
        if (normalized.includes('pg_advisory_xact_lock')) return [{}];
        if (normalized.includes('FROM pharmacy_funding_commands')) {
          return [{
            id: '9002',
            status: 'COMPLETE',
            task_id: 804,
            task_resource_type: 'pharmacy_tpa_line_decision',
            task_resource_id: '71',
            pharmacy_order_id: 71,
            governance_approval_id: 704,
            proposal_sha256: proposalSha256,
            proposer_uid: ACTOR_UID,
          }];
        }
        if (normalized.includes('FROM approvals')) {
          return [{
            id: 704,
            approval_kind: 'pharmacy_substitution_funding_reauthorisation',
            subject_resource_type: 'pharmacy_substitution_funding_proposal',
            subject_resource_id: proposalSha256,
            status: 'approved',
            task_id: 804,
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_reauthorisation_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              task_id: 804,
              task_resource_type: 'pharmacy_tpa_line_decision',
            },
          }];
        }
        if (normalized.includes('related_resource_type=ANY($3::text[])')) {
          return [{
            id: 804,
            related_resource_type: 'pharmacy_tpa_line_decision',
            related_resource_id: '71',
            status: 'completed',
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_task_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              approval_id: 704,
            },
          }];
        }
        throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
      }),
    };

    await expect(lockCounterFundingSubstitutionAuthorityTx(tx, {
      tenantId: TENANT,
      patientId: 91,
      orderId: 71,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT',
      details: {
        pharmacy_order_id: 71,
        command_receipt_ids: ['9002'],
        approval_ids: [704],
        task_ids: [804],
      },
    });
    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => (
      String(sql).includes('FROM pharmacy_advance_allocations')
    ))).toBe(false);
  });

  it('allows only an exactly cross-bound substitution approval receipt to inspect base funding', async () => {
    const proposalSha256 = 'b'.repeat(64);
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
          return [{ uid: PATIENT_UID }];
        }
        if (normalized.includes('vh:pharmacy_funding_authority:')) return [{}];
        if (normalized.includes('vh:substitution-funding:order:')) return [{}];
        if (normalized.includes('vh:pharmacy_advance_approval:')) return [{}];
        if (normalized.includes('FROM pharmacy_funding_commands')) {
          return [{
            id: '9001',
            status: 'IN_PROGRESS',
            task_id: 801,
            task_resource_type: 'pharmacy_patient_advance',
            task_resource_id: '71',
            pharmacy_order_id: 71,
            governance_approval_id: 701,
            proposal_sha256: proposalSha256,
            proposer_uid: ACTOR_UID,
          }];
        }
        if (normalized.includes('FROM approvals')) {
          return [{
            id: 701,
            approval_kind: 'pharmacy_substitution_funding_reauthorisation',
            subject_resource_type: 'pharmacy_substitution_funding_proposal',
            subject_resource_id: proposalSha256,
            status: 'pending',
            task_id: 801,
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_reauthorisation_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              task_id: 801,
              task_resource_type: 'pharmacy_patient_advance',
            },
          }];
        }
        if (normalized.includes('related_resource_type=ANY($3::text[])')) {
          return [{
            id: 801,
            related_resource_type: 'pharmacy_patient_advance',
            related_resource_id: '71',
            status: 'open',
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_task_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              approval_id: 701,
            },
          }];
        }
        if (normalized.includes('vh:pharmacy_funding_event_chain:')) return [{}];
        if (normalized.startsWith('SELECT id,patient_id,status FROM pharmacy_orders')) {
          return [{ id: 71, patient_id: 91, status: 'READY' }];
        }
        if (normalized.includes('FROM pharmacy_funding_decision_events event')) return [];
        if (normalized.startsWith('SELECT task.id AS task_id,task.status')) return [];
        throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
      }),
    };

    const substitutionFundingAuthorityLease = await lockCounterFundingSubstitutionAuthorityTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        orderId: 71,
        substitutionFundingApprovalReceiptId: '9001',
      },
    );
    await expect(resolveAuthoritativeCounterFundingTx(tx, counterFundingArgs({
      substitutionFundingAuthorityLease,
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
    });
    const queryCountAfterFirstUse = tx.$queryRawUnsafe.mock.calls.length;
    await expect(resolveAuthoritativeCounterFundingTx(tx, counterFundingArgs({
      substitutionFundingAuthorityLease,
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SUBSTITUTION_FUNDING_LEASE_REQUIRED',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(queryCountAfterFirstUse);

    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => (
      String(sql).includes('FROM pharmacy_orders')
    ))).toBe(true);
  });

  it('allows only the exact pending governance approval to replay before a command exists', async () => {
    const proposalSha256 = 'c'.repeat(64);
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
          return [{ uid: PATIENT_UID }];
        }
        if (normalized.includes('pg_advisory_xact_lock')) return [{}];
        if (normalized.includes('FROM pharmacy_funding_commands')) return [];
        if (normalized.includes('FROM approvals')) {
          return [{
            id: 702,
            approval_kind: 'pharmacy_substitution_funding_reauthorisation',
            subject_resource_type: 'pharmacy_substitution_funding_proposal',
            subject_resource_id: proposalSha256,
            status: 'pending',
            task_id: 802,
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_reauthorisation_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              task_id: 802,
              task_resource_type: 'pharmacy_posted_payment',
            },
          }];
        }
        if (normalized.includes('related_resource_type=ANY($3::text[])')) {
          return [{
            id: 802,
            related_resource_type: 'pharmacy_posted_payment',
            related_resource_id: '71',
            status: 'open',
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_task_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              approval_id: 702,
            },
          }];
        }
        throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
      }),
    };

    await expect(lockCounterFundingSubstitutionAuthorityTx(tx, {
      tenantId: TENANT,
      patientId: 91,
      orderId: 71,
      substitutionFundingGovernanceApprovalId: 702,
    })).resolves.toMatchObject({
      tenantId: TENANT,
      orderId: 71,
      patientUid: PATIENT_UID,
      authorityMode: 'governance_approval',
      governanceApprovalId: 702,
    });
  });

  it.each([
    ['task creator', { taskCreatedBy: '33333333-3333-4333-8333-333333333333' }],
    ['task proposer metadata', { taskProposerUid: '33333333-3333-4333-8333-333333333333' }],
  ])('rejects an exact pending approval with a mismatched %s', async (_name, mismatch) => {
    const proposalSha256 = 'd'.repeat(64);
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
          return [{ uid: PATIENT_UID }];
        }
        if (normalized.includes('pg_advisory_xact_lock')) return [{}];
        if (normalized.includes('FROM pharmacy_funding_commands')) return [];
        if (normalized.includes('FROM approvals')) {
          return [{
            id: 703,
            approval_kind: 'pharmacy_substitution_funding_reauthorisation',
            subject_resource_type: 'pharmacy_substitution_funding_proposal',
            subject_resource_id: proposalSha256,
            status: 'pending',
            task_id: 803,
            created_by: ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_reauthorisation_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: ACTOR_UID,
              pharmacy_order_id: 71,
              task_id: 803,
              task_resource_type: 'pharmacy_posted_payment',
            },
          }];
        }
        if (normalized.includes('related_resource_type=ANY($3::text[])')) {
          return [{
            id: 803,
            related_resource_type: 'pharmacy_posted_payment',
            related_resource_id: '71',
            status: 'open',
            created_by: mismatch.taskCreatedBy || ACTOR_UID,
            metadata: {
              contract: 'pharmacy_substitution_funding_task_v1',
              stage: 'substitution_reauthorisation',
              proposal_sha256: proposalSha256,
              proposer_uid: mismatch.taskProposerUid || ACTOR_UID,
              pharmacy_order_id: 71,
              approval_id: 703,
            },
          }];
        }
        throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
      }),
    };

    await expect(lockCounterFundingSubstitutionAuthorityTx(tx, {
      tenantId: TENANT,
      patientId: 91,
      orderId: 71,
      substitutionFundingGovernanceApprovalId: 703,
    })).rejects.toMatchObject({
      code: 'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT',
    });
  });

  it('rejects missing and foreign-transaction workflow leases before domain discovery', async () => {
    const foreignQuery = jest.fn(async (sql) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT patient.uid FROM users patient')) {
        return [{ uid: PATIENT_UID }];
      }
      if (normalized.includes('pg_advisory_xact_lock')) return [{}];
      if (normalized.includes('FROM pharmacy_funding_commands')
          || normalized.includes('FROM approvals')
          || normalized.includes('related_resource_type=ANY($3::text[])')) return [];
      throw new Error(`Unexpected counter-funding SQL: ${normalized}`);
    });
    const foreignTx = { $queryRawUnsafe: foreignQuery };
    const lease = await lockCounterFundingSubstitutionAuthorityTx(foreignTx, {
      tenantId: TENANT,
      patientId: 91,
      orderId: 71,
    });
    const tx = { $queryRawUnsafe: jest.fn() };

    await expect(resolveAuthoritativeCounterFundingTx(tx, counterFundingArgs()))
      .rejects.toMatchObject({ code: 'PHARMACY_SUBSTITUTION_FUNDING_LEASE_REQUIRED' });
    await expect(resolveAuthoritativeCounterFundingTx(tx, counterFundingArgs({
      substitutionFundingAuthorityLease: lease,
    }))).rejects.toMatchObject({ code: 'PHARMACY_SUBSTITUTION_FUNDING_LEASE_REQUIRED' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('extractPharmacyCapFromRaw', () => {
  it('returns null for empty / non-object input', () => {
    expect(extractPharmacyCapFromRaw(null)).toBeNull();
    expect(extractPharmacyCapFromRaw(undefined)).toBeNull();
    expect(extractPharmacyCapFromRaw('string')).toBeNull();
    expect(extractPharmacyCapFromRaw({})).toBeNull();
  });

  it('reads the nested caps.pharmacy.max_amount shape', () => {
    expect(extractPharmacyCapFromRaw({
      caps: { pharmacy: { max_amount: 15000, currency: 'INR' } },
    })).toBe(15000);
  });

  it('falls back to flat pharmacy_cap', () => {
    expect(extractPharmacyCapFromRaw({ pharmacy_cap: 15000 })).toBe(15000);
  });

  it('prefers nested over flat when both present', () => {
    expect(extractPharmacyCapFromRaw({
      caps: { pharmacy: { max_amount: 20000 } },
      pharmacy_cap: 99999,
    })).toBe(20000);
  });

  it('returns null for non-numeric / NaN caps', () => {
    expect(extractPharmacyCapFromRaw({ pharmacy_cap: 'abc' })).toBeNull();
  });
});

describe('shouldBlockDispense', () => {
  // Phase 1 hard-block rule.
  it('skips when probe has no cap', () => {
    expect(shouldBlockDispense({ hasCap: false, level: 'critical' })).toBe(false);
  });

  it('passes through ok / warn levels even with no override', () => {
    expect(shouldBlockDispense({ hasCap: true, level: 'ok' })).toBe(false);
    expect(shouldBlockDispense({ hasCap: true, level: 'warn' })).toBe(false);
  });

  it('blocks critical without override', () => {
    expect(shouldBlockDispense({ hasCap: true, level: 'critical' })).toBe(true);
  });

  it('allows critical with explicit override', () => {
    expect(shouldBlockDispense(
      { hasCap: true, level: 'critical' },
      { allowOverride: true },
    )).toBe(false);
  });

  it('threshold ladder is 80% warn / 100% critical', () => {
    expect(PHARMACY_CAP_WARN_PCT).toBe(80);
    expect(PHARMACY_CAP_CRITICAL_PCT).toBe(100);
  });
});
