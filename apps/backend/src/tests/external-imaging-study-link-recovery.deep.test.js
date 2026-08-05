import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  enqueueExternalRecoveryItem,
  processNextItemTx,
} from '../services/integrations/externalInterfaceRecoveryService.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from './helpers/externalRecoveryOperabilityTestHelper.js';
import { linkStudy } from '../services/radiology/pacsService.js';
import { decryptField } from '../utils/fieldEncryption.js';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'i06-study-link-test-field-key-32chars';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const ACTOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const POLICY = Object.freeze({
  policyVersion: 'c-d8-v1',
  policySignature: `i06-study-link-${SUFFIX}`,
  retentionPolicy: 'clinical-imaging-730d',
  retentionUntil: '2029-08-02T00:00:00.000Z',
});

let unlinkedOrderId;
let linkedOrderId;
const existingStudyUid = `1.2.826.0.1.3680043.8.498.6.${Date.now()}`;

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function operation(prepared) {
  return {
    tenantId: TENANT_ID,
    offsetId: prepared.offsetId,
    interfaceFamily: 'I06',
    subpath: 'study_link',
    sourcePartition: prepared.sourcePartition,
    generation: 1,
    sourcePosition: '11',
    sourceToken: prepared.sourceToken,
    predecessorToken: prepared.predecessorToken,
    duplicateKey: prepared.duplicateKey,
    occurredAt: prepared.occurredAt,
    command: prepared.command,
  };
}

async function recoverStudyLink({ orderId, studyUid, observedAt }) {
  const rawPayload = JSON.stringify({
    schema: 'vhhealth.i06.study-link/v1',
    radiology_order_id: orderId,
    study_instance_uid: studyUid,
    accession_number: `RAD-${orderId}`,
    source_system: `pacs-${SUFFIX}`,
    observed_at: observedAt,
  });
  const payloadSha256 = sha256(rawPayload);
  const sourcePartition = `radiology-order:${orderId}:study-link`;
  const predecessorToken = `i06-${orderId}-token-10`;
  const sourceToken = `i06-${orderId}-token-11`;
  const duplicateKey = `i06:study-link:${orderId}:${studyUid}:${payloadSha256}`;
  const offset = await registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: 'I06',
    subpath: 'study_link',
    sourcePartition,
    initialPosition: 10,
    initialToken: predecessorToken,
    retainedFromPosition: 10,
    retainedFromToken: predecessorToken,
    ...POLICY,
  });
  await authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I06',
    subpath: 'study_link',
    resumeCutoffPosition: 11,
    resumeCutoffToken: sourceToken,
  });
  const prepared = {
    offsetId: offset.offset_id,
    sourcePartition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    occurredAt: observedAt,
    command: {
      raw_payload: rawPayload,
      payload_sha256: payloadSha256,
      actor_uid: ACTOR_UID,
      owner_reason: 'Owner-directed reconciliation of a late PACS study link',
      evidence: { source_export: 'synthetic_i06_fixture', owner_reviewed: true },
    },
  };
  await enqueueExternalRecoveryItem(operation(prepared));
  const outcome = await processNextItemTx(operation(prepared));
  return { outcome, rawPayload, payloadSha256 };
}

async function orderEffects(orderId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ro.pacs_study_instance_uid,
            (SELECT COUNT(*)::integer FROM clinical_timeline_events e
              WHERE e.tenant_id = ro.tenant_id
                AND e.source_table = 'radiology_orders'
                AND e.source_id = ro.id::text
                AND e.event_type = 'imaging.study_linked') AS timeline_count
       FROM radiology_orders ro
      WHERE ro.tenant_id = $1::uuid AND ro.id = $2::integer`,
    TENANT_ID,
    orderId,
  );
  return rows[0];
}

describeIfDb('C6.1-E I06 late imaging study-link recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I06 study-link recovery tenant')`,
      TENANT_ID,
      `i06-study-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $4::text, 'I06 imaging patient', 'PATIENT', true, 'active', NOW()),
         ($2::uuid, $3::uuid, $5::text, 'I06 imaging owner', 'RADIOLOGIST', true, 'active', NOW())`,
      PATIENT_UID,
      ACTOR_UID,
      TENANT_ID,
      `91${SUFFIX.slice(0, 10)}`,
      `92${SUFFIX.slice(0, 10)}`,
    );
    const orders = await prisma.$queryRawUnsafe(
      `INSERT INTO radiology_orders
         (tenant_id, patient_uid, modality, body_part, clinical_indication,
          priority, status, ordered_by)
       VALUES
         ($1::uuid, $2::uuid, 'CT', 'Chest', 'I06 late unlinked proof', 'routine', 'ordered', $3::uuid),
         ($1::uuid, $2::uuid, 'MR', 'Brain', 'I06 late linked proof', 'urgent', 'ordered', $3::uuid)
       RETURNING id, modality`,
      TENANT_ID,
      PATIENT_UID,
      ACTOR_UID,
    );
    unlinkedOrderId = Number(orders.find(row => row.modality === 'CT').id);
    linkedOrderId = Number(orders.find(row => row.modality === 'MR').id);
    await linkStudy(linkedOrderId, {
      studyInstanceUid: existingStudyUid,
      accessionNumber: `RAD-${linkedOrderId}`,
    }, {
      tenantId: TENANT_ID,
      actorUid: ACTOR_UID,
      actorRole: 'RADIOLOGIST',
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('retains exact late bytes for review without creating a missing live link', async () => {
    const proposedUid = `1.2.826.0.1.3680043.8.498.61.${Date.now()}`;
    const recovered = await recoverStudyLink({
      orderId: unlinkedOrderId,
      studyUid: proposedUid,
      observedAt: '2026-08-02T06:30:00.000Z',
    });
    expect(recovered.outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i06_study_link_pending_imaging_review',
      radiology_order_id: String(unlinkedOrderId),
      cursor: {
        high_water_position: '11',
        recovery_state: 'ready',
      },
    });
    expect(await orderEffects(unlinkedOrderId)).toEqual({
      pacs_study_instance_uid: null,
      timeline_count: 0,
    });
    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT r.payload_ciphertext, r.payload_sha256::text, r.payload_bytes,
              r.receipt_status, r.evidence, t.status AS task_status,
              t.assigned_to_role, t.workflow_sla_instance_id
         FROM imaging_study_link_recovery_receipts r
         JOIN pathway_projector_inbox i
           ON i.tenant_id = r.tenant_id AND i.inbox_id = r.recovery_inbox_id
         JOIN tasks t ON t.tenant_id = i.tenant_id AND t.id = i.pending_task_id
        WHERE r.tenant_id = $1::uuid AND r.id = $2::bigint`,
      TENANT_ID,
      recovered.outcome.receipt_id,
    ));
    expect(decryptField(receipts[0].payload_ciphertext)).toBe(recovered.rawPayload);
    expect(receipts[0]).toMatchObject({
      payload_sha256: recovered.payloadSha256,
      payload_bytes: Buffer.byteLength(recovered.rawPayload, 'utf8'),
      receipt_status: 'pending_imaging_review',
      task_status: 'open',
      assigned_to_role: 'RADIOLOGIST',
      workflow_sla_instance_id: null,
      evidence: expect.objectContaining({
        byte_parity_verified: true,
        order_link_changed: false,
        timeline_event_created: false,
        target_domain_effect_performed: false,
      }),
    });
  });

  test('does not overwrite an existing live link or add a second timeline event', async () => {
    const before = await orderEffects(linkedOrderId);
    expect(before).toEqual({
      pacs_study_instance_uid: existingStudyUid,
      timeline_count: 1,
    });
    const proposedUid = `1.2.826.0.1.3680043.8.498.62.${Date.now()}`;
    const recovered = await recoverStudyLink({
      orderId: linkedOrderId,
      studyUid: proposedUid,
      observedAt: '2026-08-02T06:31:00.000Z',
    });
    expect(recovered.outcome).toMatchObject({
      outcome_code: 'i06_study_link_pending_imaging_review',
      radiology_order_id: String(linkedOrderId),
    });
    expect(await orderEffects(linkedOrderId)).toEqual(before);
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT study_instance_uid, evidence
         FROM imaging_study_link_recovery_receipts
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      recovered.outcome.receipt_id,
    ));
    expect(rows[0]).toMatchObject({
      study_instance_uid: proposedUid,
      evidence: expect.objectContaining({
        existing_study_instance_uid: existingStudyUid,
        order_link_changed: false,
        timeline_event_created: false,
      }),
    });
  });
});
