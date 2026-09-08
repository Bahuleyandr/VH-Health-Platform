import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { requireUuid } from './bloodborneMarkerRules.js';

export async function lockPatientExposureTx(tx, { tenantId, patientUid }) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenantId');
  const uid = requireUuid(patientUid, 'patientUid');
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS locked`,
    `bloodborne-exposure:${tid}:${uid}`,
  );
}

export async function deviceExposurePatientsTx(tx, { tenantId, patientUid, deviceId }) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenantId');
  const uid = requireUuid(patientUid, 'patientUid');
  const rows = deviceId == null ? [] : await tx.$queryRawUnsafe(
    `SELECT patient_uid FROM (
       SELECT patient_uid::text AS patient_uid FROM reprocessable_device_usages
        WHERE tenant_id = $1::uuid AND device_id = $2::bigint
       UNION
       SELECT dedicated_patient_uid::text AS patient_uid FROM reprocessable_device_dialysis_links
        WHERE tenant_id = $1::uuid AND device_id = $2::bigint
     ) subjects ORDER BY patient_uid`,
    tid, deviceId,
  );
  return [...new Set([uid, ...rows.map(row => String(row.patient_uid))])].sort();
}

export async function lockDeviceExposurePatientsTx(tx, input) {
  const patients = await deviceExposurePatientsTx(tx, input);
  for (const patientUid of patients) {
    await lockPatientExposureTx(tx, { tenantId: input.tenantId, patientUid });
  }
  return patients;
}

export async function assertExposurePatientLocksTx(tx, input) {
  const patients = await deviceExposurePatientsTx(tx, input);
  const locked = input.lockedPatientUids ?? [String(input.patientUid)];
  if (patients.some(patient => !locked.includes(patient))) {
    throw AppError.conflict('Exposure reconciliation must be retried', 'RPD_EXPOSURE_RECONCILIATION_PENDING');
  }
}
