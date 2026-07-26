import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const OP_CHILD_RESOURCE_EVENT_TYPE = 'appointment.child_resource_linked';

const RESOURCE_CONTRACTS = Object.freeze({
  e_prescription: Object.freeze({
    sourceTable: 'e_prescriptions',
    sql: `SELECT resource.patient_uid::text AS patient_uid,
                 resource.created_at AS occurred_at,
                 COALESCE(resource.lifecycle_status, resource.status, 'draft') AS status
            FROM e_prescriptions AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.appointment_id = $2::integer
             AND resource.id = $3::integer
           LIMIT 1
           FOR SHARE OF resource`,
  }),
  clinical_order: Object.freeze({
    sourceTable: 'clinical_orders',
    sql: `SELECT resource.patient_uid::text AS patient_uid,
                 resource.created_at AS occurred_at,
                 resource.status
            FROM clinical_orders AS resource
            JOIN patient_encounters AS encounter
              ON encounter.tenant_id = resource.tenant_id
             AND encounter.id = resource.encounter_id
             AND encounter.patient_uid = resource.patient_uid
           WHERE resource.tenant_id = $1::uuid
             AND encounter.appointment_id = $2::integer
             AND resource.id = $3::integer
           LIMIT 1
           FOR SHARE OF resource, encounter`,
  }),
  investigation: Object.freeze({
    sourceTable: 'investigations',
    sql: `SELECT resource.patient_uid::text AS patient_uid,
                 COALESCE(resource.created_at, resource.requested_at) AS occurred_at,
                 resource.status
            FROM investigations AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.appointment_id = $2::integer
             AND resource.id = $3::integer
           LIMIT 1
           FOR SHARE OF resource`,
  }),
  referral: Object.freeze({
    sourceTable: 'referrals',
    sql: `SELECT resource.patient_uid::text AS patient_uid,
                 resource.created_at AS occurred_at,
                 CASE
                   WHEN resource.closure_status = 'closed' THEN 'completed'
                   ELSE resource.status
                 END AS status
            FROM referrals AS resource
            JOIN patient_encounters AS encounter
              ON encounter.tenant_id = resource.tenant_id
             AND encounter.id = resource.encounter_id
             AND encounter.patient_uid = resource.patient_uid
           WHERE resource.tenant_id = $1::uuid
             AND encounter.appointment_id = $2::integer
             AND resource.id = $3::integer
           LIMIT 1
           FOR SHARE OF resource, encounter`,
  }),
  follow_up_plan: Object.freeze({
    sourceTable: 'follow_up_plans',
    sql: `SELECT resource.patient_uid::text AS patient_uid,
                 resource.created_at AS occurred_at,
                 resource.status
            FROM follow_up_plans AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.origin_resource_type = 'appointment'
             AND resource.origin_resource_id = $2::text
             AND resource.id = $3::integer
           LIMIT 1
           FOR SHARE OF resource`,
  }),
});

const TERMINAL_STATUS_SET = new Set([
  'cancelled',
  'closed',
  'completed',
  'discontinued',
  'issued',
  'locked',
  'resolved',
  'signed',
]);

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(
      `${label} must be a positive integer`,
      'OP_CHILD_RESOURCE_LINK_INVALID',
    );
  }
  return parsed;
}

function resourceContract(resourceType) {
  const normalized = String(resourceType || '').trim().toLowerCase();
  const contract = RESOURCE_CONTRACTS[normalized];
  if (!contract) {
    throw AppError.badRequest(
      'resource_type is not an allowed OP child resource',
      'OP_CHILD_RESOURCE_TYPE_UNSUPPORTED',
    );
  }
  return { resourceType: normalized, contract };
}

function evidenceState(status) {
  return TERMINAL_STATUS_SET.has(String(status || '').trim().toLowerCase())
    ? 'completed'
    : 'open';
}

async function loadAppointmentIdentityTx(tx, tenantId, appointmentId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT appointment.id,
            appointment.uid,
            patient.uid::text AS patient_uid
       FROM appointments AS appointment
       JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.id = $2::integer
      LIMIT 1
      FOR SHARE OF appointment, patient`,
    tenantId,
    appointmentId,
  );
  if (!rows[0]?.patient_uid) {
    throw AppError.conflict(
      'OP child resource appointment identity is unavailable',
      'OP_CHILD_APPOINTMENT_UNAVAILABLE',
    );
  }
  return rows[0];
}

export async function loadValidatedOpChildResourceTx(tx, {
  tenantId,
  appointmentId,
  patientUid,
  resourceType,
  resourceId,
} = {}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'OP child resource validation requires a transaction',
      'OP_CHILD_RESOURCE_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const appointment = await loadAppointmentIdentityTx(
    tx,
    tid,
    positiveInteger(appointmentId, 'appointment_id'),
  );
  if (
    patientUid
    && String(patientUid).toLowerCase() !== String(appointment.patient_uid).toLowerCase()
  ) {
    throw AppError.conflict(
      'OP child resource patient identity is inconsistent',
      'OP_CHILD_PATIENT_IDENTITY_INVALID',
    );
  }
  const { resourceType: type, contract } = resourceContract(resourceType);
  const id = positiveInteger(resourceId, 'resource_id');
  const rows = await tx.$queryRawUnsafe(
    contract.sql,
    tid,
    Number(appointment.id),
    id,
  );
  const resource = rows[0];
  if (
    !resource
    || String(resource.patient_uid).toLowerCase()
      !== String(appointment.patient_uid).toLowerCase()
  ) {
    throw AppError.conflict(
      'OP child resource is not exactly linked to this appointment and patient',
      'OP_CHILD_RESOURCE_LINK_INVALID',
    );
  }
  return Object.freeze({
    appointment_id: Number(appointment.id),
    appointment_uid: appointment.uid || null,
    patient_uid: String(appointment.patient_uid),
    resource_type: type,
    resource_id: String(id),
    source_table: contract.sourceTable,
    source_status: String(resource.status || '').toLowerCase() || null,
    evidence_state: evidenceState(resource.status),
    occurred_at: resource.occurred_at || new Date(),
  });
}

async function canonicalIdsTx(tx, {
  tenantId,
  patientUid,
  sourceTable,
  resourceId,
} = {}) {
  const timelineRows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND source_table = $3::text
        AND source_id = $4::text
      ORDER BY occurred_at DESC, created_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    sourceTable,
    String(resourceId),
  );
  const auditRows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND resource_table = $3::text
        AND resource_id = $4::text
      ORDER BY occurred_at DESC, created_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    sourceTable,
    String(resourceId),
  );
  return {
    canonical_timeline_event_id: timelineRows[0]?.id || null,
    canonical_audit_event_id: auditRows[0]?.id || null,
  };
}

export async function loadValidatedOpChildProjectionTx(tx, input = {}) {
  const linked = await loadValidatedOpChildResourceTx(tx, input);
  const canonical = await canonicalIdsTx(tx, {
    tenantId: requireTenantId(input.tenantId),
    patientUid: linked.patient_uid,
    sourceTable: linked.source_table,
    resourceId: linked.resource_id,
  });
  return Object.freeze({ ...linked, ...canonical });
}

export async function publishOpChildResourceLinkedTx(tx, {
  tenantId,
  appointmentId,
  patientUid,
  resourceType,
  resourceId,
  source,
} = {}) {
  const linked = await loadValidatedOpChildProjectionTx(tx, {
    tenantId,
    appointmentId,
    patientUid,
    resourceType,
    resourceId,
  });
  const { publishEvent } = await import('../events/eventOutboxService.js');
  const outbox = await publishEvent({
    eventType: OP_CHILD_RESOURCE_EVENT_TYPE,
    aggregateType: 'appointment',
    aggregateId: String(linked.appointment_id),
    patientUid: linked.patient_uid,
    payload: {
      appointment_id: linked.appointment_id,
      appointment_uid: linked.appointment_uid,
      patient_uid: linked.patient_uid,
      tenant_id: requireTenantId(tenantId),
      resource_type: linked.resource_type,
      resource_id: linked.resource_id,
      source: String(source || 'op_child_resource').slice(0, 80),
      canonical_timeline_event_id: linked.canonical_timeline_event_id,
      canonical_audit_event_id: linked.canonical_audit_event_id,
    },
    tx,
    tenantId: requireTenantId(tenantId),
  });
  if (!outbox) {
    throw AppError.internal(
      'OP child resource outbox event was not recorded',
      'OP_CHILD_RESOURCE_OUTBOX_REQUIRED',
    );
  }
  return Object.freeze({ linked, outbox });
}

export async function publishOpChildResourceLinkedFromEncounterTx(tx, {
  tenantId,
  encounterId,
  patientUid,
  resourceType,
  resourceId,
  source,
} = {}) {
  if (!encounterId) return null;
  const tid = requireTenantId(tenantId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT appointment_id
       FROM patient_encounters
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND patient_uid = $3::uuid
      LIMIT 1
      FOR SHARE`,
    tid,
    encounterId,
    patientUid,
  );
  if (!rows[0]?.appointment_id) return null;
  return publishOpChildResourceLinkedTx(tx, {
    tenantId: tid,
    appointmentId: rows[0].appointment_id,
    patientUid,
    resourceType,
    resourceId,
    source,
  });
}

export async function listExactOpChildSourcesTx(tx, {
  tenantId,
  appointmentId,
  patientUid,
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = positiveInteger(appointmentId, 'appointment_id');
  const appointment = await loadAppointmentIdentityTx(tx, tid, id);
  if (
    patientUid
    && String(patientUid).toLowerCase() !== String(appointment.patient_uid).toLowerCase()
  ) {
    throw AppError.conflict(
      'OP child source patient identity is inconsistent',
      'OP_CHILD_PATIENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT 'e_prescription'::text AS resource_type,
            resource.id::text AS resource_id
       FROM e_prescriptions AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.appointment_id = $2::integer
        AND resource.patient_uid = $3::uuid
     UNION ALL
     SELECT 'clinical_order'::text AS resource_type,
            resource.id::text AS resource_id
       FROM clinical_orders AS resource
       JOIN patient_encounters AS encounter
         ON encounter.tenant_id = resource.tenant_id
        AND encounter.id = resource.encounter_id
        AND encounter.patient_uid = resource.patient_uid
      WHERE resource.tenant_id = $1::uuid
        AND encounter.appointment_id = $2::integer
        AND resource.patient_uid = $3::uuid
     UNION ALL
     SELECT 'investigation', resource.id::text
       FROM investigations AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.appointment_id = $2::integer
        AND resource.patient_uid = $3::uuid
     UNION ALL
     SELECT 'referral', resource.id::text
       FROM referrals AS resource
       JOIN patient_encounters AS encounter
         ON encounter.tenant_id = resource.tenant_id
        AND encounter.id = resource.encounter_id
        AND encounter.patient_uid = resource.patient_uid
      WHERE resource.tenant_id = $1::uuid
        AND encounter.appointment_id = $2::integer
        AND resource.patient_uid = $3::uuid
     UNION ALL
     SELECT 'follow_up_plan', resource.id::text
       FROM follow_up_plans AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.origin_resource_type = 'appointment'
        AND resource.origin_resource_id = $2::text
        AND resource.patient_uid = $3::uuid
      ORDER BY resource_type, resource_id`,
    tid,
    id,
    appointment.patient_uid,
  );
  return rows.map((row) => Object.freeze({
    resource_type: row.resource_type,
    resource_id: row.resource_id,
  }));
}

export const __testing__ = Object.freeze({
  RESOURCE_CONTRACTS,
  evidenceState,
  resourceContract,
});

export default {
  listExactOpChildSourcesTx,
  loadValidatedOpChildProjectionTx,
  loadValidatedOpChildResourceTx,
  publishOpChildResourceLinkedTx,
  publishOpChildResourceLinkedFromEncounterTx,
};
