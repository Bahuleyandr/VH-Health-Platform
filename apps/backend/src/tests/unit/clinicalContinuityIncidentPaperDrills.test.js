import { jest } from '@jest/globals';

const IDS = Object.freeze({
  tenant: '40000000-0000-4000-8000-000000000001',
  actor: '40000000-0000-4000-8000-000000000002',
  incidents: [
    '40000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000004',
  ],
  packets: [
    '40000000-0000-4000-8000-000000000005',
    '40000000-0000-4000-8000-000000000006',
  ],
  ranges: [
    '40000000-0000-4000-8000-000000000007',
    '40000000-0000-4000-8000-000000000008',
  ],
});

let drillState;

function freshState() {
  const validFrom = new Date(Date.now() - 60_000).toISOString();
  const validUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    packets: IDS.packets.map((id, index) => ({
      id,
      tenant_id: IDS.tenant,
      facility_id: 17,
      reserved_incident_id: IDS.incidents[index],
      canonical_payload_hash: String(index + 1).repeat(64),
      signature: `signature-${index}`,
      status: 'unused',
      valid_from: validFrom,
      valid_until: validUntil,
      trusted_now: new Date().toISOString(),
      revoked_at: null,
      range_prefix: `C52-${index + 1}-`,
      range_first: 1,
      range_last: 99,
      packet_key_id: 'test-key',
      packet_key_version: '1',
    })),
    incidents: [],
    declarations: [],
    paperItems: [],
    reconciliation: [],
    rangeStatus: 'in_use',
    audits: 0,
    linkTask: false,
    linkedTaskId: null,
  };
}

const tx = {
  $executeRawUnsafe: jest.fn(async (sql, ...params) => {
    if (sql.includes('UPDATE clinical_continuity_incident_packets')) {
      const packet = drillState.packets.find(row => row.id === params[3]);
      packet.status = 'used';
    }
    return 1;
  }),
  $queryRawUnsafe: jest.fn(async (sql, ...params) => {
    if (sql.includes('clinical_continuity_consume_incident_packet')) {
      const packet = drillState.packets.find(row => row.id === params[2]);
      packet.status = 'used';
      return [packet];
    }
    if (sql.includes('FROM clinical_continuity_incident_packets')) {
      return drillState.packets.filter(row => row.id === params[2]);
    }
    if (sql.includes('SELECT id::text') && sql.includes('alias_disposition')) {
      const canonical = drillState.incidents.find(row => row.alias_disposition === 'canonical');
      return canonical ? [{ id: canonical.id }] : [];
    }
    if (sql.includes('FROM clinical_continuity_incidents')
      && sql.includes('id = $3::uuid')
      && !sql.includes('SELECT incident.*, range.id AS paper_range_id')) {
      return drillState.incidents.filter(row => row.id === params[2]);
    }
    if (sql.includes('INSERT INTO clinical_continuity_incidents')) {
      const row = {
        id: params[0],
        tenant_id: params[1],
        facility_id: params[2],
        packet_id: params[3],
        canonical_incident_id: params[4],
        alias_disposition: params[5],
        commander_uid: params[6],
        lifecycle_state: 'declared',
        version: 1,
      };
      drillState.incidents.push(row);
      return [row];
    }
    if (sql.includes('INSERT INTO clinical_continuity_paper_ranges')) {
      const packetIndex = IDS.packets.indexOf(params[3]);
      return [{
        id: IDS.ranges[packetIndex],
        incident_id: params[2],
        status: 'in_use',
        range_prefix: params[4],
        range_first: params[5],
        range_last: params[6],
      }];
    }
    if (sql.includes('INSERT INTO clinical_continuity_incident_declarations')) {
      const row = { id: `declaration-${drillState.declarations.length + 1}`, conflict_disposition: params[11] };
      drillState.declarations.push(row);
      return [row];
    }
    if (sql.includes('SELECT incident.*, range.id AS paper_range_id')) {
      if (params[1] !== 17) return [];
      const incident = drillState.incidents.find(row => row.id === params[2]);
      if (!incident) return [];
      return [{
        ...incident,
        paper_range_id: IDS.ranges[IDS.incidents.indexOf(incident.id)],
        range_prefix: 'C52-1-',
        range_first: 1,
        range_last: 99,
        range_status: drillState.rangeStatus,
      }];
    }
    if (sql.includes('FROM clinical_continuity_paper_items') && sql.includes('paper_item_id = $4')) {
      return drillState.paperItems.filter(row => row.incident_id === params[2] && row.paper_item_id === params[3]);
    }
    if (sql.includes('INSERT INTO clinical_continuity_paper_items')) {
      const row = {
        id: `paper-row-${drillState.paperItems.length + 1}`,
        incident_id: params[2],
        paper_item_id: params[5],
        paper_item_number: params[6],
        item_kind: params[7],
        action_id: params[8],
        original_actor_uid: params[9],
        original_actor_role: params[10],
        occurred_at: params[11],
        patient_uid: params[13],
        temporary_identity_id: params[14],
        encounter_id: params[15],
        evidence_hash: params[16],
        reconciliation_disposition: params[17],
        version: 1,
      };
      drillState.paperItems.push(row);
      return [row];
    }
    if (sql.includes('FROM clinical_continuity_reconciliation_config')) {
      return [{
        fallback_principal: 'role:quality_officer',
        clinical_safety_lead_uid: IDS.actor,
        needs_review_owner_principal: 'role:quality_officer',
        identity_owner_principal: 'role:medical_records',
        interface_owner_principal: 'role:it_admin',
      }];
    }
    if (sql.includes('INSERT INTO clinical_continuity_reconciliation_items')) {
      const row = {
        id: `review-${drillState.reconciliation.length + 1}`,
        queue_type: params[3],
        reason_code: params[4],
        paper_item_row_id: params[5],
        safety_critical: params[10],
        task_id: drillState.linkTask ? null : 501,
        version: 1,
      };
      drillState.reconciliation.push(row);
      return [row];
    }
    if (sql.includes('UPDATE clinical_continuity_reconciliation_items')) {
      drillState.linkedTaskId = params[0];
      const row = drillState.reconciliation.at(-1);
      row.task_id = params[0];
      row.version += 1;
      return [row];
    }
    throw new Error(`Unexpected incident/paper SQL: ${sql.slice(0, 120)}`);
  }),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(tx)),
}));
const recordClinicalAuditEvent = jest.fn(async () => {
  drillState.audits += 1;
  return { id: `audit-${drillState.audits}` };
});
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  recordClinicalAuditEvent,
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));
const createTask = jest.fn(async () => ({ id: 601 }));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask,
  transitionTask: jest.fn(),
}));
jest.unstable_mockModule('../../services/downtime/clinicalContinuityPolicyService.js', () => ({
  INCIDENT_PACKET_SIGNING_KEY_PURPOSE: 'clinical_continuity_incident_packet_signing',
  INCIDENT_PACKET_SIGNING_PURPOSE: 'vhhealth/continuity/incident-packet/v1',
  loadActiveClinicalContinuityPolicyForFacilityTx: jest.fn(),
  requireClinicalContinuityIncidentPacketPolicy: jest.fn(),
}));

const {
  declareClinicalContinuityIncident,
  registerClinicalContinuityPaperItem,
} = await import('../../services/downtime/clinicalContinuityReconciliationService.js');

function declare(index) {
  return declareClinicalContinuityIncident({
    tenantId: IDS.tenant,
    facilityId: 17,
    actorUid: IDS.actor,
    actorRole: 'ADMIN',
    expectedVersion: 0,
    packetId: IDS.packets[index],
    reservedIncidentId: IDS.incidents[index],
    signedCanonicalHash: String(index + 1).repeat(64),
    signature: `signature-${index}`,
    occurredAt: new Date(Date.now() - 10_000).toISOString(),
    declarationSource: 'offline_import',
  });
}

function register(evidenceHash = 'a'.repeat(64), facilityId = 17, originalActorUid = null) {
  return registerClinicalContinuityPaperItem({
    tenantId: IDS.tenant,
    facilityId,
    actorUid: IDS.actor,
    actorRole: 'ADMIN',
    incidentId: IDS.incidents[0],
    paperItemId: 'C52-1-7',
    expectedVersion: 1,
    itemKind: 'other',
    originalActorUid,
    evidenceHash,
  });
}

describe('C5.2 incident and paper-range hard drills', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drillState = freshState();
  });

  test('records two valid commander declarations as canonical plus split-brain and deduplicates packet import', async () => {
    expect(await declare(0)).toMatchObject({ disposition: 'declared' });
    expect(await declare(1)).toMatchObject({ disposition: 'split_brain_needs_review' });
    expect(drillState.incidents).toHaveLength(2);
    expect(drillState.declarations.map(row => row.conflict_disposition)).toEqual(['accepted', 'split_brain']);

    const duplicate = await declare(1);
    expect(duplicate).toMatchObject({ disposition: 'exact_duplicate' });
    expect(drillState.incidents).toHaveLength(2);
    expect(drillState.declarations).toHaveLength(2);
  });

  test.each(['lost', 'revoked'])('preserves a %s-range item and routes it to safety review', async (rangeStatus) => {
    await declare(0);
    drillState.rangeStatus = rangeStatus;
    const result = await register();
    expect(result).toMatchObject({
      disposition: 'needs_review',
      paper_item: { reconciliation_disposition: 'lost_revoked' },
      reconciliation_item: {
        queue_type: 'needs_review',
        reason_code: 'CONTINUITY_PAPER_RANGE_LOST_OR_REVOKED',
        safety_critical: true,
      },
    });
  });

  test('returns exact duplicate, queues a same-tuple evidence mismatch, and hides cross-facility existence', async () => {
    await declare(0);
    expect(await register()).toMatchObject({ disposition: 'registered' });
    expect(await register()).toMatchObject({ disposition: 'exact_duplicate' });
    expect(await register('a'.repeat(64), 17, IDS.actor)).toMatchObject({
      disposition: 'needs_review',
      reconciliation_item: { reason_code: 'CONTINUITY_PAPER_ITEM_IDENTITY_MISMATCH' },
    });
    expect(await register('b'.repeat(64))).toMatchObject({
      disposition: 'needs_review',
      reconciliation_item: { reason_code: 'CONTINUITY_PAPER_ITEM_IDENTITY_MISMATCH' },
    });
    await expect(register('a'.repeat(64), 18)).rejects.toMatchObject({
      code: 'CONTINUITY_INCIDENT_NOT_FOUND',
    });
    expect(drillState.paperItems).toHaveLength(1);
  });

  test('creates one canonical task with no fabricated SLA when no owner-approved target exists', async () => {
    await declare(0);
    drillState.rangeStatus = 'lost';
    drillState.linkTask = true;
    const result = await register();
    expect(result.reconciliation_item.task_id).toBe(601);
    expect(drillState.linkedTaskId).toBe(601);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: IDS.tenant,
      taskKind: 'review',
      relatedResourceType: 'clinical_continuity_reconciliation_item',
      priority: 'critical',
      slaCompletionSemantics: 'none',
      onConflictResourceDoNothing: true,
      tx,
      metadata: expect.objectContaining({
        continuity_incident_id: IDS.incidents[0],
        queue_type: 'needs_review',
        recorded_at_source: 'server',
      }),
    }));
    expect(createTask.mock.calls[0][0].dueAt).toBeUndefined();
    expect(recordClinicalAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clinical_continuity.paper_item.registered',
        resourceType: 'clinical_continuity_paper_item',
      }),
      { db: tx },
    );
  });
});
