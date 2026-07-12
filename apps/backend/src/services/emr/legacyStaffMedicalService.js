import { setTenantTx } from '../../lib/prisma.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';

export async function createLegacyStaffConsultation({
  tenantId,
  patientUid,
  doctorId = null,
  consultationType = 'Consultation',
  notes = null,
  attachments = {},
  actorUid = null,
  actorRole = null,
  requestId = null,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  return setTenantTx(scopedTenantId, async (tx) => {
    const record = await tx.medical_records.create({
      data: {
        patient_id: patientUid,
        doctor_id: doctorId,
        record_type: 'CONSULTATION',
        title: String(consultationType),
        description: notes,
        attachments: { source: 'staff_app_legacy', ...attachments },
        privacy_level: 'RESTRICTED',
        created_by: actorUid,
        tenant_id: scopedTenantId,
      },
      select: {
        id: true,
        patient_id: true,
        doctor_id: true,
        record_type: true,
        title: true,
        description: true,
        created_by: true,
        created_at: true,
      },
    });

    const canonical = await recordCanonicalClinicalEvent({
      tenantId: scopedTenantId,
      patientUid,
      eventType: 'legacy_consultation.recorded',
      eventSubtype: String(consultationType),
      eventStatus: 'recorded',
      sourceTable: 'medical_records',
      sourceId: record.id,
      resourceType: 'medical_record',
      resourceId: record.id,
      actorUid,
      actorRole,
      requestId,
      visibleToPatient: false,
      summary: 'Staff consultation entry recorded',
      payload: {
        record_type: record.record_type,
        consultation_type: String(consultationType),
        source: 'staff_app_legacy',
      },
      afterState: {
        record_type: record.record_type,
        privacy_level: 'RESTRICTED',
      },
      timelineIdempotencyKey: `medical_records:${record.id}:legacy_consultation`,
      auditIdempotencyKey: `medical_records:${record.id}:audit:legacy_consultation`,
    }, { db: tx, strict: true });

    if (!canonical?.timeline || !canonical?.audit) {
      const error = new Error('Consultation canonical event was not recorded');
      error.code = 'CONSULTATION_CANONICAL_EVENT_REQUIRED';
      throw error;
    }
    return record;
  });
}

export default { createLegacyStaffConsultation };
