import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  enqueueExternalRecoveryItem,
  processNextItemTx,
  readExternalRecoveryResumeState,
} from '../services/integrations/externalInterfaceRecoveryService.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from './helpers/externalRecoveryOperabilityTestHelper.js';
import {
  I09_GATEWAY_SEQUENCE_CONTRACT,
  I15_FHIR_SEQUENCE_CONTRACT,
  canonicalResourceSha256,
  i09DuplicateKey,
  i09SourceToken,
  lengthPrefixedSha256,
  sha256Utf8,
  validateI09GatewayRecovery,
  validateI15FhirRecovery,
} from '../services/integrations/externalVitalsRecoveryService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const POLICY = Object.freeze({
  policyVersion: 'c-d8-v1',
  policySignature: `synthetic-${SUFFIX}`,
  retentionPolicy: 'clinical-observation-730d',
  retentionUntil: '2029-07-31T00:00:00.000Z',
});

let gatewayId;
let deviceId;

function operation(prepared) {
  return {
    tenantId: TENANT_ID,
    offsetId: prepared.offsetId,
    interfaceFamily: prepared.interfaceFamily,
    subpath: prepared.subpath,
    sourcePartition: prepared.sourcePartition,
    generation: prepared.generation,
    sourcePosition: prepared.sourcePosition,
    sourceToken: prepared.sourceToken,
    predecessorToken: prepared.predecessorToken,
    duplicateKey: prepared.duplicateKey,
    occurredAt: prepared.occurredAt,
    command: prepared.command,
    commandFingerprint: prepared.commandFingerprint,
  };
}

async function effectCounts() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM vitals_chart
         WHERE tenant_id = $1::uuid AND recovery_inbox_id IS NOT NULL) AS observations,
       (SELECT COUNT(*)::integer FROM tasks
         WHERE tenant_id = $1::uuid AND related_resource_type = 'vitals_chart') AS tasks,
       (SELECT COUNT(*)::integer FROM news2_scores n
         JOIN users u ON u.uid = n.patient_uid
        WHERE u.tenant_id = $1::uuid) AS news2,
       (SELECT COUNT(*)::integer FROM clinical_alerts a
         JOIN users u ON u.id = a.patient_id
        WHERE u.tenant_id = $1::uuid) AS alerts,
       (SELECT COUNT(*)::integer FROM workflow_sla_instances
         WHERE tenant_id = $1::uuid) AS slas,
       (SELECT COUNT(*)::integer FROM care_pathway_transition_events
         WHERE tenant_id = $1::uuid) AS transitions,
       (SELECT COUNT(*)::integer FROM notification_outbox
         WHERE tenant_id = $1::uuid) AS notifications`,
    TENANT_ID,
  );
  return rows[0];
}

async function registerOffset(interfaceFamily, sourcePartition, initialToken) {
  return registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily,
    subpath: interfaceFamily === 'I15' ? 'fhir_write' : null,
    sourcePartition,
    initialPosition: 10,
    initialToken,
    retainedFromPosition: 10,
    retainedFromToken: initialToken,
    ...POLICY,
  });
}

describeIfDb('C6.1-B I09/I15 late vitals recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-B vitals recovery tenant')`,
      TENANT_ID,
      `c61b-vitals-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'C6.1-B patient', 'PATIENT', true, NOW())`,
      PATIENT_UID,
      TENANT_ID,
      `94${SUFFIX.slice(0, 10)}`,
    );
    const devices = await prisma.$queryRawUnsafe(
      `INSERT INTO device_registry
         (tenant_id, device_code, display_name, kind, protocol, status)
       VALUES
         ($1::uuid, $2::text, 'C6.1-B gateway', 'monitor_gateway', 'mllp-hl7v2', 'active'),
         ($1::uuid, $3::text, 'C6.1-B monitor', 'monitor', 'mllp-hl7v2', 'active')
       RETURNING id, device_code`,
      TENANT_ID,
      `GW-${SUFFIX}`,
      `MON-${SUFFIX}`,
    );
    gatewayId = Number(devices.find((row) => row.device_code === `GW-${SUFFIX}`).id);
    deviceId = Number(devices.find((row) => row.device_code === `MON-${SUFFIX}`).id);
  });

  afterAll(async () => {
    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM lab_interface_messages WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM vitals_chart WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox
          WHERE tenant_id = $1::uuid AND scope_kind = 'external_interface'`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND scope_kind = 'external_interface'`,
        TENANT_ID,
      );
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM device_registry WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$disconnect();
  }, 60_000);

  it('serves the exact I09 resume-state contract and never invents a marker', async () => {
    const sourcePartition = `i09/gateway/${gatewayId}/device/${deviceId}`;
    const offset = await registerOffset('I09', sourcePartition, 'i09-token-10');
    const state = await readExternalRecoveryResumeState({
      tenantId: TENANT_ID,
      interfaceFamily: 'I09',
      sourcePartition,
    });
    expect(Object.keys(state)).toEqual([
      'contract', 'interface_family', 'tenant_id', 'offset_id', 'source_partition',
      'generation', 'recovery_state', 'high_water_position', 'high_water_token',
      'retained_from_position', 'retained_from_token', 'resume_cutoff_position',
      'resume_cutoff_token', 'policy_version', 'policy_signature',
      'retention_policy', 'retention_until',
    ]);
    expect(state).toMatchObject({
      contract: I09_GATEWAY_SEQUENCE_CONTRACT,
      interface_family: 'I09',
      tenant_id: TENANT_ID,
      offset_id: offset.offset_id,
      source_partition: sourcePartition,
      recovery_state: 'paused',
      high_water_position: '10',
      high_water_token: 'i09-token-10',
    });
    await expect(readExternalRecoveryResumeState({
      tenantId: TENANT_ID,
      interfaceFamily: 'I09',
      sourcePartition: `${sourcePartition}/missing`,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_MARKER_MISSING' });
  });

  it('persists I09 bytes and occurrence exactly, creates pending review, and emits no live effects', async () => {
    const sourcePartition = `i09/gateway/${gatewayId}/device/${deviceId}`;
    const message = [
      `MSH|^~\\&|MON-${SUFFIX}|ICU|||20260731123100+0530||ORU^R01|MSG-${SUFFIX}|P|2.5`,
      `PID|||${PATIENT_UID}`,
      'OBR|1|||85354-9|||20260731123000+0530',
      'OBX|1|NM|8867-4^Heart rate||88|/min',
      'OBX|2|NM|2708-6^SpO2||91|%',
    ].join('\r');
    const duplicateKey = i09DuplicateKey({
      tenantId: TENANT_ID,
      deviceRegistryId: deviceId,
      msh10: `MSG-${SUFFIX}`,
    });
    const messageSha256 = sha256Utf8(message);
    const sourceToken = i09SourceToken({
      tenantId: TENANT_ID,
      sourcePartition,
      generation: 1,
      sourcePosition: '11',
      predecessorToken: 'i09-token-10',
      duplicateKey,
      messageSha256,
    });
    const offsets = await setTenantTx(TENANT_ID, (tx) => tx.$queryRawUnsafe(
      `SELECT offset_id::text FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND interface_family = 'I09'
          AND source_partition = $2::text`,
      TENANT_ID,
      sourcePartition,
    ));
    const envelope = {
      schema: I09_GATEWAY_SEQUENCE_CONTRACT,
      interface_family: 'I09',
      arrival_class: 'recovery_backlog',
      tenant_id: TENANT_ID,
      gateway_registry_id: gatewayId,
      device_registry_id: deviceId,
      offset_id: offsets[0].offset_id,
      source_partition: sourcePartition,
      generation: 1,
      source_position: '11',
      source_token: sourceToken,
      predecessor_token: 'i09-token-10',
      msh10: `MSG-${SUFFIX}`,
      duplicate_key: duplicateKey,
      message_sha256: messageSha256,
      gateway_received_at: '2026-07-31T12:31:05+05:30',
      clock_evidence: { source: 'ntp', offset_ms: 9 },
    };
    const prepared = await setTenantTx(TENANT_ID, (tx) => validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message,
      deviceCode: `MON-${SUFFIX}`,
      patientUid: PATIENT_UID,
      recovery: envelope,
    }, { tx }));
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: prepared.offsetId,
      interfaceFamily: 'I09',
      resumeCutoffPosition: prepared.sourcePosition,
      resumeCutoffToken: prepared.sourceToken,
    });
    const before = await effectCounts();
    await enqueueExternalRecoveryItem(operation(prepared));
    const outcome = await processNextItemTx(operation(prepared));
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i09_vitals_observation_pending_review',
      cursor: {
        high_water_position: '11',
        high_water_token: sourceToken,
        recovery_state: 'ready',
      },
    });
    const after = await effectCounts();
    expect(after).toEqual({
      observations: before.observations + 1,
      tasks: before.tasks + 1,
      news2: before.news2,
      alerts: before.alerts,
      slas: before.slas,
      transitions: before.transitions,
      notifications: before.notifications,
    });
    const evidence = await setTenantTx(TENANT_ID, (tx) => tx.$queryRawUnsafe(
      `SELECT v.id, EXTRACT(EPOCH FROM v.recorded_at)::text AS recorded_epoch,
              v.source, v.device_verified, v.triage_acuity,
              v.recovery_inbox_id::text, m.raw_message, m.raw_message_sha256,
              t.status AS task_status, t.workflow_sla_instance_id,
              t.sla_completion_semantics,
              (SELECT COUNT(*)::integer FROM clinical_timeline_events c
                WHERE c.tenant_id = v.tenant_id AND c.source_table = 'vitals_chart'
                  AND c.source_id = v.id::text) AS timeline_count,
              (SELECT COUNT(*)::integer FROM clinical_audit_events a
                WHERE a.tenant_id = v.tenant_id AND a.resource_table = 'vitals_chart'
                  AND a.resource_id = v.id::text) AS audit_count
         FROM vitals_chart v
         JOIN lab_interface_messages m
           ON m.tenant_id = v.tenant_id AND m.recovery_inbox_id = v.recovery_inbox_id
         JOIN pathway_projector_inbox i
           ON i.tenant_id = v.tenant_id AND i.inbox_id = v.recovery_inbox_id
         JOIN tasks t ON t.tenant_id = i.tenant_id AND t.id = i.pending_task_id
        WHERE v.tenant_id = $1::uuid AND v.id = $2::integer`,
      TENANT_ID,
      Number(outcome.observation_id),
    ));
    expect(evidence[0]).toMatchObject({
      source: 'device',
      device_verified: false,
      triage_acuity: null,
      raw_message: message,
      raw_message_sha256: messageSha256,
      task_status: 'open',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      timeline_count: 1,
      audit_count: 1,
    });
    expect(Number(evidence[0].recorded_epoch) * 1000)
      .toBe(Date.parse('2026-07-31T07:00:00.000Z'));
    await expect(enqueueExternalRecoveryItem(operation(prepared)))
      .rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING' });
    expect(await effectCounts()).toEqual(after);
  }, 60_000);

  it('persists I15 FHIR observation evidence through the same tenant-only fence', async () => {
    const clientId = `client-${SUFFIX}`;
    const sourcePartition = `i15/client/${clientId}/resource/Observation`;
    const offset = await registerOffset('I15', sourcePartition, 'i15-token-10');
    const resource = {
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: `Patient/${PATIENT_UID}` },
      effectiveDateTime: '2026-07-31T12:45:00+05:30',
      code: { coding: [{ system: 'http://loinc.org', code: '9279-1' }] },
      valueQuantity: { value: 24, unit: '/min' },
    };
    const eventIdentity = `event-${SUFFIX}`;
    const duplicateKey = lengthPrefixedSha256([
      'vh-i15-duplicate-v1', TENANT_ID, clientId, eventIdentity,
    ]);
    const resourceSha256 = canonicalResourceSha256(resource);
    const sourceToken = lengthPrefixedSha256([
      'vh-i15-source-token-v1', TENANT_ID, sourcePartition, '1', '11',
      'i15-token-10', duplicateKey, resourceSha256,
    ]);
    const prepared = validateI15FhirRecovery({
      tenantId: TENANT_ID,
      apiClientId: clientId,
      resource,
      recovery: {
        schema: I15_FHIR_SEQUENCE_CONTRACT,
        interface_family: 'I15',
        arrival_class: 'recovery_backlog',
        tenant_id: TENANT_ID,
        api_client_id: clientId,
        offset_id: offset.offset_id,
        source_partition: sourcePartition,
        generation: 1,
        source_position: '11',
        source_token: sourceToken,
        predecessor_token: 'i15-token-10',
        event_identity: eventIdentity,
        duplicate_key: duplicateKey,
        resource_sha256: resourceSha256,
        client_received_at: '2026-07-31T12:45:05+05:30',
        clock_evidence: {},
      },
    });
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I15',
      subpath: 'fhir_write',
      resumeCutoffPosition: '11',
      resumeCutoffToken: sourceToken,
    });
    const before = await effectCounts();
    await enqueueExternalRecoveryItem(operation(prepared));
    const outcome = await processNextItemTx(operation(prepared));
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i15_vitals_observation_pending_review',
      cursor: { recovery_state: 'ready' },
    });
    const after = await effectCounts();
    expect(after).toEqual({
      observations: before.observations + 1,
      tasks: before.tasks + 1,
      news2: before.news2,
      alerts: before.alerts,
      slas: before.slas,
      transitions: before.transitions,
      notifications: before.notifications,
    });
    const rows = await setTenantTx(TENANT_ID, (tx) => tx.$queryRawUnsafe(
      `SELECT source, device_verified, triage_acuity, respiratory_rate,
              EXTRACT(EPOCH FROM recorded_at)::text AS recorded_epoch,
              recovery_interface_family
         FROM vitals_chart
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID,
      Number(outcome.observation_id),
    ));
    expect(rows[0]).toMatchObject({
      source: 'fhir',
      device_verified: null,
      triage_acuity: null,
      recovery_interface_family: 'I15',
    });
    expect(Number(rows[0].respiratory_rate)).toBe(24);
    expect(Number(rows[0].recorded_epoch) * 1000)
      .toBe(Date.parse('2026-07-31T07:15:00.000Z'));
  }, 60_000);
});
