import { readFileSync, readdirSync } from 'node:fs';

import {
  CLINICAL_CONTINUITY_C_D14_APPROVED,
  clinicalContinuityPaperReconciliationEnabled,
} from '../../config/downtimeConfig.js';

const migrationSql = readFileSync(
  new URL('../../migrations/606_clinical_continuity_paper_reconciliation.sql', import.meta.url),
  'utf8',
);
const routesSource = readFileSync(
  new URL('../../routes/downtime/clinicalContinuityReconciliationRoutes.js', import.meta.url),
  'utf8',
);
const controllerSource = readFileSync(
  new URL('../../controllers/downtime/clinicalContinuityReconciliationController.js', import.meta.url),
  'utf8',
);
const serviceSource = readFileSync(
  new URL('../../services/downtime/clinicalContinuityReconciliationService.js', import.meta.url),
  'utf8',
);
const buildRunbook = readFileSync(
  new URL('../../../../../docs/continuity/c5-2-paper-reconciliation-build-runbook.md', import.meta.url),
  'utf8',
);

describe('C5.2 inert build and closed command boundary', () => {
  test('cannot activate while the owner-signed C-D14 gate is absent', () => {
    const allFlags = {
      CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED: 'true',
      CLINICAL_CONTINUITY_FACILITY_CONTEXT_ENABLED: 'true',
      CLINICAL_CONTINUITY_REPLAY_RECEIPTS_ENABLED: 'true',
      CLINICAL_CONTINUITY_PAPER_RECONCILIATION_ENABLED: 'true',
    };
    expect(CLINICAL_CONTINUITY_C_D14_APPROVED).toBe(false);
    expect(clinicalContinuityPaperReconciliationEnabled(allFlags)).toBe(false);
  });

  test('mounts three typed fact routes with no generic replay or transfer route', () => {
    expect(routesSource).toContain("'/incidents/:incidentId/paper-items/:paperItemId/mar-administration'");
    expect(routesSource).toContain("'/incidents/:incidentId/paper-items/:paperItemId/lab-specimen-collection'");
    expect(routesSource).toContain("'/incidents/:incidentId/paper-items/:paperItemId/blood-transfusion-verification'");
    expect(routesSource).not.toMatch(/router\.(?:post|put|patch)\([^\n]*(?:generic|\/replay|transfer)/i);
  });

  test('derives declaration source from the route instead of client authority', () => {
    expect(routesSource).toContain("router.post('/incidents/declare', declareIncident)");
    expect(routesSource).toContain("router.post('/incidents/import', importIncident)");
    expect(controllerSource).toContain("recordIncidentDeclaration(req, res, next, 'online')");
    expect(controllerSource).toContain("recordIncidentDeclaration(req, res, next, 'offline_import')");
    expect(controllerSource).not.toContain('req.body?.declaration_source');
  });

  test('authorizes the locked paper patient before receipt visibility and scopes staff reads', () => {
    expect(controllerSource).toContain('patientAuthorizer: authorizePaperPatient(req, actionId)');
    expect(controllerSource).toContain('ACCESS_POLICY_CODES.PATIENT_CONTINUITY_MAR_BACK_ENTRY');
    expect(controllerSource).toContain('ACCESS_POLICY_CODES.PATIENT_CONTINUITY_SPECIMEN_BACK_ENTRY');
    expect(controllerSource).toContain('ACCESS_POLICY_CODES.PATIENT_CONTINUITY_TRANSFUSION_BACK_ENTRY');
    expect(serviceSource.indexOf('requireAuthorizedPaperPatient(patientAuthorizer')).toBeLessThan(
      serviceSource.indexOf('const existing = await loadPaperReceiptTx'),
    );
    expect(serviceSource).toContain('AND incident_id = $3::uuid AND id = $4::uuid');
    expect(serviceSource).toContain('AND ($4::boolean OR item.assigned_to_uid = $5::uuid)');
    expect(serviceSource).toContain('OR item.original_actor_uid = $5::uuid');
  });

  test('uses the C5.1 receipt, canonical timeline, task, audit, and C6.1 late fence', () => {
    expect(serviceSource).toContain('clinical_continuity_paper_receipt_claim');
    expect(serviceSource).toContain('clinical_continuity_replay_receipt_finalize');
    expect(serviceSource).toContain("set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)");
    expect(serviceSource).toContain('recordCanonicalClinicalEvent');
    expect(serviceSource).toContain('recordClinicalAuditEvent');
    expect(serviceSource).toContain('clinical_continuity.device_offset.recorded');
    expect(serviceSource).toContain('clinical_continuity.interface_requirement.recorded');
    expect(serviceSource).toContain('createTask');
    expect(serviceSource).toContain("retrospectiveEffectDisposition: 'late_pending_only'");
    expect(serviceSource).not.toMatch(/suppress_(sla_breach_alarm|care_pathway_transition|patient_notification)/);
    expect(serviceSource).not.toContain('INSERT INTO transfusion_verifications');
    expect(serviceSource).not.toContain('assertBedsideVerified');
    expect(serviceSource).not.toMatch(/from ['"].*(?:transfer|notification|pathway).*Service\.js['"]/i);
  });
});

describe('migration 606 static authority contract', () => {
  test('is unambiguous and extends C5.1 rather than creating parallel engines', () => {
    expect(
      readdirSync(new URL('../../migrations/', import.meta.url)).filter(name => name.startsWith('606_')),
    ).toEqual(['606_clinical_continuity_paper_reconciliation.sql']);
    expect(migrationSql).toContain('ALTER TABLE public.clinical_continuity_replay_receipts');
    expect(migrationSql).toContain("source_kind = 'paper_back_entry'");
    expect(migrationSql).not.toMatch(/CREATE TABLE public\.[a-z0-9_]*(?:paper_receipt|workflow_task|workflow_sla|patient_merge_request)/i);
  });

  test('contains restrictive tenant/facility RLS, least privilege, and immutable evidence guards', () => {
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('AS RESTRICTIVE');
    expect(migrationSql).toContain("current_setting('app.current_facility_id', true)");
    expect(migrationSql).toContain('cc_append_only_guard');
    expect(migrationSql).toContain('cc_incident_projection_guard');
    expect(migrationSql).toContain('cc_closure_actor_separation');
    expect(migrationSql).toContain('uq_cc_temp_identity_incident_id');
    expect(migrationSql).toContain('fk_cc_reconciliation_device_offset');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, facility_id, incident_id, temporary_identity_id)');
    expect(migrationSql).toContain('REVOKE ALL PRIVILEGES');
    expect(migrationSql).toContain('REVOKE UPDATE, DELETE, TRUNCATE');
  });

  test('persists the three clocks, late-only effect, typed queues, and existing task link', () => {
    expect(migrationSql).toMatch(/occurred_at TIMESTAMPTZ(?:\(6\))?[\s\S]*recorded_at TIMESTAMPTZ(?:\(6\))?[\s\S]*reviewed_at TIMESTAMPTZ(?:\(6\))?/);
    expect(migrationSql).toContain("CHECK (effect_disposition = 'late_pending_only')");
    expect(migrationSql).toContain("CHECK (queue_type IN ('needs_review', 'identity', 'interface'))");
    expect(migrationSql).toContain('FOREIGN KEY (task_id) REFERENCES public.tasks(id)');
    expect(migrationSql).toContain('workflow_sla_instance_id');
  });
});

describe('C5.2 Gate classification and rollback receipt', () => {
  test('keeps all 44 hospital-area/platform classifications pending owner signature', () => {
    const areas = [
      'Ward', 'Emergency department', 'Outpatient department',
      'Theatre/operating room', 'ICU/NICU/PICU', 'Maternity', 'Cath lab',
      'Dialysis', 'Pharmacy', 'Laboratory', 'Blood bank',
    ];
    const platforms = ['Android', 'Windows/desktop', 'Browser/web', 'iOS'];
    const cells = areas.flatMap(area => platforms.map(platform => ({
      area,
      platform,
      classification: 'owner-classification-pending',
    })));
    expect(cells).toHaveLength(44);
    expect(new Set(cells.map(cell => cell.classification))).toEqual(
      new Set(['owner-classification-pending']),
    );
    expect(buildRunbook).toContain('All cells remain **owner-classification-pending**');
    expect(buildRunbook).toContain('not claims that any area/platform cell is owner-approved');
  });

  test('documents the exact adapter boundary and non-destructive rollback', () => {
    expect(buildRunbook).toContain('Ward medication administration');
    expect(buildRunbook).toContain('Laboratory specimen collection');
    expect(buildRunbook).toMatch(/Blood\s+Bank transfusion verification/);
    expect(buildRunbook).toContain('Do not reverse migration 606');
    expect(buildRunbook).toContain('Merge, deploy, activation, and production-readiness claim: **not authorized**');
  });
});
