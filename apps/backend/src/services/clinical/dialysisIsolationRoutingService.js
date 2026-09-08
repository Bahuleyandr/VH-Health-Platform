import { AppError } from '../../utils/AppError.js';
import { calendarDateIso } from '../../utils/calendarDate.js';
import { assessIsolationTx, cohortCompatibilityTx } from './dialysisReuseService.js';
import { boundIsolationEmergencyIdTx, validateIsolationEmergencyTx } from './dialysisIsolationEmergencyService.js';
import { lockPatientExposureTx } from './patientExposureLock.js';

export function computeIsolationWarnings({ decision, machine, isolationGroups, enforcement }) {
  const requiredGroup = decision.status === 'restricted'
    ? (isolationGroups?.[decision.isolation_class] ?? null) : null;
  const codes = [];
  if (decision.status === 'restricted') {
    if (!machine) codes.push('DIALYSIS_MACHINE_UNREGISTERED');
    else if (requiredGroup === null) codes.push('DIALYSIS_ISOLATION_GROUP_UNMAPPED');
    else if (machine.isolation_group !== requiredGroup) codes.push('DIALYSIS_ISOLATION_MACHINE_MISMATCH');
  } else if (decision.status === 'unknown' && machine?.isolation_group) {
    codes.push('DIALYSIS_UNKNOWN_ON_DEDICATED_GROUP');
  } else if (decision.status === 'clear' && machine?.isolation_group) {
    codes.push('DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE');
  }
  return {
    codes,
    required_group: requiredGroup,
    blocked: enforcement === 'block' && codes.some(
      (code) => code !== 'DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE',
    ),
  };
}

export async function planIsolationTx(tx, {
  tenantId, patientUid, machineNo, sessionDate, sessionId, body = {}, captureEmergencyAuthorizationId,
}) {
  if (body.isolation_emergency_authorization_id) await lockPatientExposureTx(tx, { tenantId, patientUid });
  // Bookings in the same routing population must not pass against concurrent empty reads.
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':dialysis_routing', 0))::text`,
    tenantId,
  );
  const [settings] = await tx.$queryRawUnsafe(
    `WITH settings AS (
       SELECT config.isolation_enforcement, revision.isolation_groups
       FROM reprocessing_domain_settings config
       LEFT JOIN reprocessing_isolation_setting_revisions revision
         ON revision.tenant_id = config.tenant_id AND revision.id = config.isolation_revision_id
       WHERE config.tenant_id = $1::uuid AND config.domain = 'dialysis'
     )
     SELECT COALESCE(settings.isolation_enforcement, 'warn') AS isolation_enforcement,
            settings.isolation_groups
     FROM reprocessing_domain_policies policy LEFT JOIN settings ON TRUE
     WHERE policy.tenant_id = $1::uuid AND policy.domain = 'dialysis'
       AND policy.category = 'dialyser' AND policy.reprocessable`,
    tenantId,
  );
  const authorizationId = body.isolation_emergency_authorization_id
    ?? (sessionId == null ? null : await boundIsolationEmergencyIdTx(tx, { tenantId, sessionId }));
  if (!settings) {
    if (authorizationId) {
      throw AppError.conflict('Approved dialysis routing configuration is required', 'DIALYSIS_ISOLATION_EMERGENCY_UNAVAILABLE');
    }
    return null;
  }

  const [machine] = await tx.$queryRawUnsafe(
    `SELECT id, status, isolation_group FROM dialysis_machines
     WHERE tenant_id = $1::uuid AND machine_no = $2 FOR SHARE`,
    tenantId, machineNo ?? null,
  );
  if (machine && machine.status !== 'active') {
    throw AppError.conflict('The selected dialysis machine is inactive', 'DIALYSIS_MACHINE_INACTIVE');
  }
  const decision = await assessIsolationTx({ tenantId, patientUid, db: tx });
  const warning = computeIsolationWarnings({
    decision, machine, isolationGroups: settings.isolation_groups,
    enforcement: settings.isolation_enforcement,
  });
  if (warning.blocked && !authorizationId) {
    throw AppError.conflict(
      warning.required_group
        ? `The patient must be dialysed on a machine in isolation group ${warning.required_group}`
        : 'The patient requires an appropriate isolation machine',
      'DIALYSIS_ISOLATION_MACHINE_BLOCKED',
      { codes: warning.codes, required_group: warning.required_group },
    );
  }
  const emergencyOverride = authorizationId ? await validateIsolationEmergencyTx(tx, {
    tenantId, authorizationId, patientUid, machineId: machine?.id,
    scheduledFor: body.scheduled_start_at, sessionId, codes: warning.codes,
  }) : null;
  const cohort = await tx.$queryRawUnsafe(
    `SELECT DISTINCT patient.patient_uid
     FROM dialysis_sessions session
     JOIN dialysis_patients patient
       ON patient.tenant_id = session.tenant_id AND patient.id = session.dialysis_patient_id
     JOIN dialysis_machines machine
       ON machine.tenant_id = session.tenant_id AND machine.machine_no = session.machine_no
     WHERE session.tenant_id = $1::uuid AND session.status IN ('scheduled', 'in_progress')
       AND session.session_date = $2::date
       AND ($3::integer IS NULL OR session.id <> $3::integer)
       AND machine.isolation_group IS NOT DISTINCT FROM $4::text
       AND patient.patient_uid <> $5::uuid`,
    tenantId, calendarDateIso(sessionDate) || null, sessionId ?? null,
    machine?.isolation_group ?? null, patientUid,
  );
  if (machine?.isolation_group && cohort.length > 0) {
    const { verdict } = await cohortCompatibilityTx({
      tenantId, patientUid, cohortPatientUids: cohort.map((row) => row.patient_uid), machine, db: tx,
    });
    if (verdict !== 'compatible') {
      throw AppError.conflict('The selected dialysis cohort is not compatible', 'DIALYSIS_COHORT_INCOMPATIBLE');
    }
  }
  if (emergencyOverride && captureEmergencyAuthorizationId) captureEmergencyAuthorizationId(authorizationId);
  return {
    codes: warning.codes,
    required_group: warning.required_group,
    isolation_warnings: warning.codes.map((code) => ({
      code, machine_id: machine?.id ?? null, severity: 'warn', required_group: warning.required_group,
    })),
    warn_only: settings.isolation_enforcement !== 'block',
    enforcement_enabled: settings.isolation_enforcement === 'block',
    isolation_override: emergencyOverride,
    evaluated_at: decision.asOf,
    audit_summary: { status: decision.status, evidence: decision.evidence, asOf: decision.asOf },
  };
}

export async function admitIsolationTx(tx, { session, actor, body = {}, ...context }) {
  const result = await planIsolationTx(tx, {
    ...context, sessionDate: context.sessionDate ?? session?.session_date,
    sessionId: context.sessionId ?? session?.id, body,
  });
  if (result?.isolation_override?.kind === 'emergency') return result;
  if (!result || result.codes.length === 0) return result;
  const reason = typeof body.isolation_override_reason === 'string'
    ? body.isolation_override_reason.trim() : '';
  if (!reason || !actor?.uid) {
    throw AppError.badRequest('An isolation warning acknowledgement is required', 'DIALYSIS_ISOLATION_OVERRIDE_REQUIRED');
  }
  return {
    ...result,
    isolation_override: { reason, by: actor.uid, at: result.evaluated_at, kind: 'reason' },
  };
}
