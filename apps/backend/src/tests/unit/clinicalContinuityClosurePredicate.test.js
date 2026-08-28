import { jest } from '@jest/globals';

const IDS = Object.freeze({
  tenant: '20000000-0000-4000-8000-000000000001',
  incident: '20000000-0000-4000-8000-000000000002',
  commander: '20000000-0000-4000-8000-000000000003',
  safetyLead: '20000000-0000-4000-8000-000000000004',
  range: '20000000-0000-4000-8000-000000000005',
  paper: '20000000-0000-4000-8000-000000000006',
  identity: '20000000-0000-4000-8000-000000000007',
  device: '20000000-0000-4000-8000-000000000008',
  interface: '20000000-0000-4000-8000-000000000009',
  offset: '20000000-0000-4000-8000-000000000010',
  queue: '20000000-0000-4000-8000-000000000011',
});

let closureState;

const tx = {
  $executeRawUnsafe: jest.fn(async () => 1),
  $queryRawUnsafe: jest.fn(async (sql) => {
    if (sql.includes('FROM clinical_continuity_reconciliation_config')) {
      return [{
        fallback_principal: 'role:clinical_safety_lead',
        clinical_safety_lead_uid: IDS.safetyLead,
        needs_review_owner_principal: 'role:quality_officer',
        identity_owner_principal: 'role:medical_records',
        interface_owner_principal: 'role:quality_officer',
      }];
    }
    if (sql.includes('FROM clinical_continuity_incidents')) {
      return [{ id: IDS.incident, version: 9, commander_uid: IDS.commander, lifecycle_state: 'reconciling' }];
    }
    if (sql.includes('FROM clinical_continuity_paper_ranges')) {
      return [{ id: IDS.range, version: 2, status: 'accounted', range_last: 10n, last_accounted_number: 10n }];
    }
    if (sql.includes('FROM clinical_continuity_paper_items')) {
      return [{
        id: IDS.paper,
        paper_item_id: 'WARD-10',
        reconciliation_disposition: 'applied',
        receipt_client_event_id: 'receipt',
        fact_id: 'fact',
        version: 2,
      }];
    }
    if (sql.includes('FROM clinical_continuity_temporary_identities')) {
      return [{ id: IDS.identity, version: 2, identity_status: 'matched', safety_critical: true }];
    }
    if (sql.includes('FROM clinical_continuity_device_journal_offsets')) {
      return [{
        id: IDS.device,
        version: 2,
        disposition: 'reconciled',
        required_high_water_mark: 10n,
        observed_high_water_mark: BigInt(closureState.deviceHighWater),
      }];
    }
    if (sql.includes('FROM clinical_continuity_incident_interfaces')) {
      return [{
        id: IDS.interface,
        version: 2,
        disposition: 'reconciled',
        offset_id: IDS.offset,
        required_generation: 4,
        required_high_water_position: 20n,
        required_high_water_token: 'token-20',
      }];
    }
    if (sql.includes('FROM event_consumer_offsets')) {
      return [{
        offset_id: IDS.offset,
        generation: 4,
        high_water_position: closureState.interfaceHighWater == null
          ? null
          : BigInt(closureState.interfaceHighWater),
        high_water_token: closureState.interfaceToken,
        recovery_state: 'recovered',
      }];
    }
    if (sql.includes('FROM clinical_continuity_reconciliation_items')) {
      return [{
        id: IDS.queue,
        version: 3,
        disposition: closureState.queueDisposition,
        safety_critical: true,
        owner_principal: 'role:quality_officer',
        assigned_to_uid: IDS.safetyLead,
        task_id: null,
        task_status: closureState.queueDisposition === 'resolved' ? 'completed' : 'open',
      }];
    }
    if (sql.includes('FROM clinical_continuity_incident_attestations')) {
      return closureState.attestations;
    }
    throw new Error(`Unexpected closure SQL: ${sql.slice(0, 120)}`);
  }),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(tx)),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  recordClinicalAuditEvent: jest.fn(),
  recordMedicationSafetyReviews: jest.fn(),
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  claimMarMedicationExceptionTaskTx: jest.fn(),
  completeTaskFromDomainEvidence: jest.fn(),
  createApproval: jest.fn(),
  createMarMedicationExceptionTaskTx: jest.fn(),
  createTask: jest.fn(),
  recordApprovalDecision: jest.fn(),
  transitionTask: jest.fn(),
}));
jest.unstable_mockModule('../../services/downtime/clinicalContinuityPolicyService.js', () => ({
  INCIDENT_PACKET_SIGNING_KEY_PURPOSE: 'clinical_continuity_incident_packet_signing',
  INCIDENT_PACKET_SIGNING_PURPOSE: 'vhhealth/continuity/incident-packet/v1',
  loadActiveClinicalContinuityPolicyForFacilityTx: jest.fn(),
  requireClinicalContinuityIncidentPacketPolicy: jest.fn(),
}));

const { checkClinicalContinuityClosure } = await import(
  '../../services/downtime/clinicalContinuityReconciliationService.js'
);

function check({ actorUid = IDS.commander, actorRole = 'ADMIN' } = {}) {
  return checkClinicalContinuityClosure({
    tenantId: IDS.tenant,
    facilityId: 17,
    actorUid,
    actorRole,
    incidentId: IDS.incident,
  });
}

describe('C5.2 locked closure predicate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    closureState = {
      deviceHighWater: 9,
      interfaceHighWater: 19,
      interfaceToken: 'token-19',
      queueDisposition: 'open',
      attestations: [],
    };
  });

  test('blocks device lag, interface lag, unresolved safety work, and both absent keys', async () => {
    const result = await check();
    expect(result.eligible).toBe(false);
    expect(result.blockers.map(row => row.code)).toEqual(expect.arrayContaining([
      'CONTINUITY_CLOSURE_DEVICE_HWM_BLOCKER',
      'CONTINUITY_CLOSURE_INTERFACE_HWM_BLOCKER',
      'CONTINUITY_CLOSURE_SAFETY_ITEM_BLOCKER',
      'CONTINUITY_CLOSURE_COMMANDER_ATTESTATION_REQUIRED',
      'CONTINUITY_CLOSURE_CLINICAL_ATTESTATION_REQUIRED',
    ]));
  });

  test('denies closure evidence to an unrelated broad-route staff role', async () => {
    await expect(check({ actorUid: IDS.device, actorRole: 'NURSING_STAFF' })).rejects.toMatchObject({
      code: 'CONTINUITY_CLOSURE_ROLE_DENIED',
      statusCode: 403,
    });
  });

  test('does not treat a missing observed HWM as zero even when the requirement is non-negative', async () => {
    closureState.deviceHighWater = 10;
    closureState.interfaceHighWater = null;
    closureState.interfaceToken = 'token-20';
    closureState.queueDisposition = 'resolved';
    const result = await check();
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CONTINUITY_CLOSURE_INTERFACE_HWM_BLOCKER' }),
    ]));
  });

  test('recomputes the offset under lock and invalidates the predicate when HWM changes', async () => {
    closureState.deviceHighWater = 10;
    closureState.interfaceHighWater = 20;
    closureState.interfaceToken = 'token-20';
    closureState.queueDisposition = 'resolved';
    closureState.attestations = [
      { attestation_kind: 'operational', actor_uid: IDS.commander },
      { attestation_kind: 'clinical', actor_uid: IDS.safetyLead },
    ];
    const eligible = await check();
    expect(eligible.eligible).toBe(true);

    closureState.interfaceHighWater = 19;
    const changed = await check();
    expect(changed.eligible).toBe(false);
    expect(changed.predicate_snapshot_hash).not.toBe(eligible.predicate_snapshot_hash);
    expect(changed.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CONTINUITY_CLOSURE_INTERFACE_HWM_BLOCKER' }),
    ]));
  });

  test('rejects two keys from one actor even if the database were bypassed', async () => {
    closureState.deviceHighWater = 10;
    closureState.interfaceHighWater = 20;
    closureState.interfaceToken = 'token-20';
    closureState.queueDisposition = 'resolved';
    closureState.attestations = [
      { attestation_kind: 'operational', actor_uid: IDS.commander },
      { attestation_kind: 'clinical', actor_uid: IDS.commander },
    ];
    const result = await check();
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CONTINUITY_CLOSURE_ACTOR_SEPARATION_REQUIRED' }),
    ]));
  });
});
