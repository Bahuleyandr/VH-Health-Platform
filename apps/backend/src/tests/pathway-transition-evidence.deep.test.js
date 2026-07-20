import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import prisma, { setTenantTx } from '../lib/prisma.js';

const actualCanonicalModule =
  await import('../services/clinical/canonicalClinicalPlatformService.js');
const faultControl = {
  bypassFaultInjection: false,
  failAudit: false,
  failAuditAt: null,
  callCount: 0
};

jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonicalModule,
  recordCanonicalClinicalEvent: (input, options = {}) => {
    if (faultControl.bypassFaultInjection) {
      return actualCanonicalModule.recordCanonicalClinicalEvent(input, options);
    }
    faultControl.callCount += 1;
    const shouldFail =
      faultControl.failAudit || faultControl.callCount === faultControl.failAuditAt;
    return actualCanonicalModule.recordCanonicalClinicalEvent(input, {
      ...options,
      db: shouldFail ? failCanonicalAuditDb(options.db) : options.db
    });
  }
}));

const { appendPathwayTransitionEventTx, appendPathwayTransitionEventsBatchTx } =
  await import('../services/pathways/pathwayTransitionEventService.js');

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const ROLLBACK_MARKER = 'rollback pathway transition evidence fixture';
const FORCED_AUDIT_FAILURE = 'forced canonical audit failure';
const DEFINITION_CHECKSUM = 'e'.repeat(64);
const GOVERNANCE_APPROVAL_KIND = 'care_pathway_definition_governance';
const GOVERNANCE_SUBJECT_TYPE = 'care_pathway_definition';
const GOVERNANCE_DECIDED_AT = '2026-07-19T08:00:00.000Z';
const GOVERNANCE_APPROVED_AT = '2026-07-19T08:01:00.000Z';

function phoneFor(value, suffix) {
  const digits = value.replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  return `+91${digits.slice(0, 9)}${suffix}`;
}

function userActor(uid) {
  return {
    kind: 'user',
    uid,
    roles: ['DOCTOR'],
    authorizationMode: 'assigned_user'
  };
}

async function seedPathway(tx, tenantId, patientUid, actorUid) {
  const token = tenantId.replaceAll('-', '').slice(0, 12);
  const pathwayKey = `synthetic_evidence_${token}`;
  const approverUid = randomUUID();
  const sourceEpisodeId = `episode-${token}`;
  const instanceIdempotencyKey = `instance:${token}`;
  await tx.$queryRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, 'Pathway transition evidence deep test')`,
    tenantId,
    `pathway-evidence-${token}`
  );
  await tx.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
      VALUES ($1::uuid, $2::uuid, $3::text, 'Evidence Patient', 'PATIENT', true, NOW()),
             ($4::uuid, $2::uuid, $5::text, 'Evidence Doctor', 'DOCTOR', true, NOW()),
             ($6::uuid, $2::uuid, $7::text, 'Evidence Approver', 'ADMIN', true, NOW())`,
    patientUid,
    tenantId,
    phoneFor(patientUid, '1'),
    actorUid,
    phoneFor(actorUid, '2'),
    approverUid,
    phoneFor(approverUid, '3')
  );
  const definitions = await tx.$queryRawUnsafe(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, steps, triggers, defaults, is_active, created_by)
      VALUES
        ($1::uuid, $2::text, 1,
         '[{"step_key":"review_result","step_kind":"task"}]'::jsonb,
         '[]'::jsonb, '{}'::jsonb, true, $3::uuid)
      RETURNING id`,
    tenantId,
    pathwayKey,
    actorUid
  );
  const workflowDefinitionId = Number(definitions[0].id);
  const approvals = await tx.$queryRawUnsafe(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
        required_approvers, status, approved_by, decided_by, decided_at, metadata)
     VALUES
       ($1::uuid, $2::text, $3::text, $4::text,
        1, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
        jsonb_build_object(
          'care_pathway_definition_governance',
          jsonb_build_object('definition_checksum', $8::text)
        ))
     RETURNING id`,
    tenantId,
    GOVERNANCE_APPROVAL_KIND,
    GOVERNANCE_SUBJECT_TYPE,
    String(workflowDefinitionId),
    JSON.stringify([{ uid: approverUid, at: GOVERNANCE_DECIDED_AT }]),
    approverUid,
    GOVERNANCE_DECIDED_AT,
    DEFINITION_CHECKSUM
  );
  const governance = await tx.$queryRawUnsafe(
    `INSERT INTO care_pathway_definition_governance
       (tenant_id, workflow_definition_id, clinical_owner_uid, operational_owner_uid,
        governance_status, approval_id, approved_by, approved_at,
        patient_visibility_policy_ref, definition_checksum)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $3::uuid,
        'approved', $4::integer, $5::uuid, $6::timestamptz,
        'staff_after_signoff', $7::char(64))
     RETURNING id`,
    tenantId,
    workflowDefinitionId,
    actorUid,
    Number(approvals[0].id),
    approverUid,
    GOVERNANCE_APPROVED_AT,
    DEFINITION_CHECKSUM
  );
  const governanceId = governance[0].id;
  const runs = await tx.$queryRawUnsafe(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
         pathway_governance_id, pathway_definition_checksum,
         trigger_kind, status, initiated_by)
     VALUES
       ($1::uuid, $2::integer, $3::text, 1, $4::uuid, $5::char(64),
        'manual', 'running', $6::uuid)
     RETURNING id`,
    tenantId,
    workflowDefinitionId,
    pathwayKey,
    governanceId,
    DEFINITION_CHECKSUM,
    actorUid
  );
  const instances = await tx.$queryRawUnsafe(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
         workflow_definition_id, definition_governance_id, definition_checksum,
         source_episode_type, source_episode_id, accountable_role, clinical_status,
         patient_visibility_status, idempotency_key, created_by, updated_by)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $4::text, 1,
        $5::integer, $6::uuid, $7::char(64),
        'synthetic_order', $8::text, 'DOCTOR', 'active',
        'hidden', $9::text, $10::uuid, $10::uuid)
     RETURNING id, workflow_run_id`,
    tenantId,
    Number(runs[0].id),
    patientUid,
    pathwayKey,
    workflowDefinitionId,
    governanceId,
    DEFINITION_CHECKSUM,
    sourceEpisodeId,
    instanceIdempotencyKey,
    actorUid
  );
  const instanceId = instances[0].id;
  const runId = Number(instances[0].workflow_run_id);
  faultControl.bypassFaultInjection = true;
  try {
    await appendPathwayTransitionEventTx({
      tx,
      tenantId,
      pathwayInstanceId: instanceId,
      workflowRunId: runId,
      idempotencyKey: instanceIdempotencyKey,
      commandFingerprint: 'f'.repeat(64),
      effectOrdinal: 0,
      transitionScope: 'pathway',
      transitionKey: 'pathway_instance_created',
      previousState: {},
      newState: { clinical_status: 'active', run_status: 'running' },
      sourceResourceType: 'synthetic_order',
      sourceResourceId: sourceEpisodeId,
      occurredAt: '2026-07-19T08:02:00.000Z',
      actor: userActor(actorUid),
      eventPayload: {
        mode: 'shadow',
        workflow_definition_id: workflowDefinitionId,
        governance_id: governanceId,
        definition_checksum: DEFINITION_CHECKSUM
      },
      metadata: {
        pathway_runtime: {
          mode: 'shadow',
          definition_checksum: DEFINITION_CHECKSUM
        }
      }
    });
  } finally {
    faultControl.bypassFaultInjection = false;
  }
  return {
    instanceId,
    runId
  };
}

function appendInput({
  tx,
  tenantId,
  instanceId,
  runId,
  actorUid,
  idempotencyKey,
  fingerprint,
  effectOrdinal
} = {}) {
  return {
    tx,
    tenantId,
    pathwayInstanceId: instanceId,
    workflowRunId: runId,
    idempotencyKey,
    commandFingerprint: fingerprint,
    effectOrdinal,
    transitionScope: 'pathway',
    transitionKey: effectOrdinal === 0 ? 'pathway.started' : 'pathway.reviewed',
    previousState: { status: effectOrdinal === 0 ? 'planned' : 'active' },
    newState: { status: 'active' },
    sourceResourceType: 'synthetic_order',
    sourceResourceId: idempotencyKey,
    occurredAt: '2026-07-19T10:00:00.000Z',
    actor: userActor(actorUid),
    eventPayload: { deep_test: true },
    metadata: { pathway_mode: 'shadow' }
  };
}

function batchAppendInput({
  tx,
  tenantId,
  instanceId,
  runId,
  actorUid,
  idempotencyKey,
  fingerprint,
  effectCount,
  occurredAt = '2026-07-19T10:00:00.000Z'
} = {}) {
  return {
    tx,
    tenantId,
    pathwayInstanceId: instanceId,
    workflowRunId: runId,
    idempotencyKey,
    commandFingerprint: fingerprint,
    occurredAt,
    actor: userActor(actorUid),
    intents: Array.from({ length: effectCount }, (_, ordinal) => ({
      transitionScope: 'step',
      transitionKey: `step.effect_${ordinal}`,
      stageKey: `stage_${ordinal}`,
      previousState: { status: ordinal === 0 ? 'running' : 'pending' },
      newState: { status: 'completed' },
      sourceResourceType: 'synthetic_order',
      sourceResourceId: idempotencyKey,
      eventPayload: { deep_test: true, ordinal },
      metadata: { pathway_mode: 'shadow' }
    }))
  };
}

function failCanonicalAuditDb(tx) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          if (/INSERT\s+INTO\s+clinical_audit_events/i.test(String(sql))) {
            throw new Error(FORCED_AUDIT_FAILURE);
          }
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function countTenantEvidence(tenantId) {
  return setTenantTx(tenantId, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid) AS timeline_count,
         (SELECT COUNT(*)::integer
            FROM care_pathway_transition_events
           WHERE tenant_id = $1::uuid) AS transition_count`,
      tenantId
    );
    return {
      timelineCount: Number(rows[0].timeline_count),
      transitionCount: Number(rows[0].transition_count)
    };
  });
}

d('pathway transition evidence PostgreSQL conformance', () => {
  beforeEach(() => {
    faultControl.bypassFaultInjection = false;
    faultControl.failAudit = false;
    faultControl.failAuditAt = null;
    faultControl.callCount = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('persists contiguous multi-effect events with one canonical pair each and replays exactly', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const actorUid = randomUUID();
    const idempotencyKey = `deep-command:${tenantId}`;
    const fingerprint = 'a'.repeat(64);

    await expect(
      setTenantTx(tenantId, async tx => {
        const { instanceId, runId } = await seedPathway(tx, tenantId, patientUid, actorUid);
        const first = await appendPathwayTransitionEventTx(
          appendInput({
            tx,
            tenantId,
            instanceId,
            runId,
            actorUid,
            idempotencyKey,
            fingerprint,
            effectOrdinal: 0
          })
        );
        const second = await appendPathwayTransitionEventTx(
          appendInput({
            tx,
            tenantId,
            instanceId,
            runId,
            actorUid,
            idempotencyKey,
            fingerprint,
            effectOrdinal: 1
          })
        );
        const replay = await appendPathwayTransitionEventTx(
          appendInput({
            tx,
            tenantId,
            instanceId,
            runId,
            actorUid,
            idempotencyKey,
            fingerprint,
            effectOrdinal: 0
          })
        );

        expect([first.event.sequence_number, second.event.sequence_number]).toEqual([2, 3]);
        expect(replay).toMatchObject({ replayed: true, event: { id: first.event.id } });
        const rows = await tx.$queryRawUnsafe(
          `SELECT sequence_number, effect_ordinal,
                canonical_timeline_event_id, canonical_audit_event_id
           FROM care_pathway_transition_events
          WHERE tenant_id = $1::uuid AND idempotency_key = $2::text
          ORDER BY effect_ordinal`,
          tenantId,
          idempotencyKey
        );
        expect(rows.map(row => Number(row.sequence_number))).toEqual([2, 3]);
        expect(rows.map(row => Number(row.effect_ordinal))).toEqual([0, 1]);
        expect(
          rows.every(row => row.canonical_timeline_event_id && row.canonical_audit_event_id)
        ).toBe(true);

        throw new Error(ROLLBACK_MARKER);
      })
    ).rejects.toThrow(ROLLBACK_MARKER);
  }, 60_000);

  it('appends and exactly replays a contiguous batch with one sequence allocation', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const actorUid = randomUUID();
    const idempotencyKey = `deep-batch:${tenantId}`;
    const fingerprint = 'c'.repeat(64);
    const effectCount = 12;
    const expectedInstant = '2026-07-19T04:30:00.000Z';

    await expect(
      setTenantTx(tenantId, async tx => {
        const { instanceId, runId } = await seedPathway(tx, tenantId, patientUid, actorUid);
        const input = batchAppendInput({
          tx,
          tenantId,
          instanceId,
          runId,
          actorUid,
          idempotencyKey,
          fingerprint,
          effectCount,
          occurredAt: '2026-07-19T10:00:00+05:30'
        });
        const first = await appendPathwayTransitionEventsBatchTx(input);
        const replay = await appendPathwayTransitionEventsBatchTx(input);

        expect(first.replayed).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(replay.events.map(event => event.id)).toEqual(first.events.map(event => event.id));
        const rows = await tx.$queryRawUnsafe(
          `SELECT p.sequence_number, p.effect_ordinal,
                  p.occurred_at = t.occurred_at AS timeline_matches,
                  p.occurred_at = a.occurred_at AS audit_matches,
                  p.occurred_at = $3::timestamptz AS input_matches,
                  p.event_payload ->> 'occurred_at' AS payload_occurred_at
             FROM care_pathway_transition_events p
             JOIN clinical_timeline_events t
               ON t.tenant_id = p.tenant_id
              AND t.id = p.canonical_timeline_event_id
             JOIN clinical_audit_events a
               ON a.tenant_id = p.tenant_id
              AND a.id = p.canonical_audit_event_id
            WHERE p.tenant_id = $1::uuid AND p.idempotency_key = $2::text
            ORDER BY p.effect_ordinal`,
          tenantId,
          idempotencyKey,
          expectedInstant
        );
        expect(rows.map(row => Number(row.sequence_number))).toEqual(
          Array.from({ length: effectCount }, (_, index) => index + 2)
        );
        expect(rows.map(row => Number(row.effect_ordinal))).toEqual(
          Array.from({ length: effectCount }, (_, index) => index)
        );
        expect(
          rows.every(row => row.timeline_matches && row.audit_matches && row.input_matches)
        ).toBe(true);
        expect(rows.map(row => row.payload_occurred_at)).toEqual(
          Array(effectCount).fill(expectedInstant)
        );

        throw new Error(ROLLBACK_MARKER);
      })
    ).rejects.toThrow(ROLLBACK_MARKER);
  }, 60_000);

  it('rolls back the entire batch when a later canonical pair fails', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const actorUid = randomUUID();
    const idempotencyKey = `deep-batch-failure:${tenantId}`;

    faultControl.failAuditAt = 2;
    try {
      await expect(
        setTenantTx(tenantId, async tx => {
          const { instanceId, runId } = await seedPathway(tx, tenantId, patientUid, actorUid);
          await appendPathwayTransitionEventsBatchTx(
            batchAppendInput({
              tx,
              tenantId,
              instanceId,
              runId,
              actorUid,
              idempotencyKey,
              fingerprint: 'd'.repeat(64),
              effectCount: 3
            })
          );
        })
      ).rejects.toThrow(FORCED_AUDIT_FAILURE);
    } finally {
      faultControl.failAuditAt = null;
    }

    expect(faultControl.callCount).toBe(2);
    await expect(countTenantEvidence(tenantId)).resolves.toEqual({
      timelineCount: 0,
      transitionCount: 0
    });
  }, 60_000);

  it('rolls back the timeline and transition when the canonical audit write fails', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const actorUid = randomUUID();
    const idempotencyKey = `deep-failure:${tenantId}`;

    await expect(
      setTenantTx(tenantId, async tx => {
        const { instanceId, runId } = await seedPathway(tx, tenantId, patientUid, actorUid);
        faultControl.failAudit = true;
        try {
          await expect(
            appendPathwayTransitionEventTx(
              appendInput({
                tx,
                tenantId,
                instanceId,
                runId,
                actorUid,
                idempotencyKey,
                fingerprint: 'b'.repeat(64),
                effectOrdinal: 0
              })
            )
          ).rejects.toThrow(FORCED_AUDIT_FAILURE);
        } finally {
          faultControl.failAudit = false;
        }

        const timelineRows = await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::integer AS count
           FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid
            AND resource_type = 'care_pathway_transition_event'
            AND payload->>'idempotency_key' = $2::text`,
          tenantId,
          idempotencyKey
        );
        const transitionRows = await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::integer AS count
           FROM care_pathway_transition_events
          WHERE tenant_id = $1::uuid
            AND idempotency_key = $2::text`,
          tenantId,
          idempotencyKey
        );
        expect(Number(timelineRows[0].count)).toBe(1);
        expect(Number(transitionRows[0].count)).toBe(0);
        throw new Error(ROLLBACK_MARKER);
      })
    ).rejects.toThrow(ROLLBACK_MARKER);

    await expect(countTenantEvidence(tenantId)).resolves.toEqual({
      timelineCount: 0,
      transitionCount: 0
    });
  }, 60_000);
});
