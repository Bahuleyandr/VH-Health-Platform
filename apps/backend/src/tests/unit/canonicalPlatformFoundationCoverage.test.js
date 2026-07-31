import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(process.cwd(), '../..');

function readRepo(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('canonical clinical platform foundation coverage guard', () => {
  it('keeps backend platform helpers and encounter routes exposed', () => {
    const service = readRepo('apps/backend/src/services/clinical/canonicalClinicalPlatformService.js');
    const routes = readRepo('apps/backend/src/routes/clinical/encounterRoutes.js');

    for (const token of [
      'recordTimelineEvent',
      'recordClinicalAuditEvent',
      'ensureEncounterForAppointment',
      'transitionEncounter',
      'listClinicalAuditEvents',
      'listWorkflowSlaInstances',
      'listMedicationSafetyReviews',
      'evaluateMedicationSafety',
      'getClinicalDocumentationTemplates',
    ]) {
      expect(service).toContain(token);
    }

    for (const routeToken of [
      '/documentation/templates',
      '/medication-safety/evaluate',
      '/:id/audit',
      '/:id/slas',
      '/:id/medication-safety',
      '/:id/activate',
      '/:id/sign',
      '/:id/amend',
      '/:id/lock',
    ]) {
      expect(routes).toContain(routeToken);
    }
  });

  it('keeps medication safety categories present in the canonical safety engine', () => {
    const source = readRepo('apps/backend/src/utils/clinical/prescriptionSafetyCheck.js');
    for (const token of [
      'ALLERGY_CONFLICT',
      'DUPLICATE_MEDICATION',
      'PAEDIATRIC_DOSE_HIGH',
      'ANTITHROMBOTIC_INTERACTION',
      'PREGNANCY_MEDICATION_RISK',
      'RENAL_MEDICATION_REVIEW',
      'ANTIBIOTIC_STEWARDSHIP_RESERVE',
    ]) {
      expect(source).toContain(token);
    }
  });

  it('keeps Staff typed models and typed platform API calls for the foundation', () => {
    const models = readRepo('apps/staff/lib/core/models/clinical_platform_models.dart');
    const service = readRepo('apps/staff/lib/core/services/clinical_platform_api_service.dart');

    for (const model of [
      'ClinicalEncounter',
      'ClinicalTimelineEvent',
      'ClinicalAuditEvent',
      'MedicationSafetyReview',
      'MedicationSafetyEvaluation',
      'WorkflowSlaInstance',
      'ClinicalDocumentationTemplate',
      'RolePolicySnapshot',
    ]) {
      expect(models).toContain(`class ${model}`);
    }

    for (const method of [
      'getPatientTimeline',
      'getEncounter',
      'getEncounterAuditEvents',
      'getEncounterWorkflowSlas',
      'getEncounterMedicationSafety',
      'evaluateMedicationSafety',
      'getClinicalDocumentationTemplates',
      'getRolePolicySnapshot',
    ]) {
      expect(service).toContain(method);
    }

    expect(models).not.toContain('class ClinicalDowntimePolicy');
    expect(service).not.toContain('getClinicalDowntimePolicy');
    expect(service).not.toContain('/encounters/downtime-policy');
  });

  it('keeps Staff signed action-policy models and typed enforcement wired', () => {
    const policyModel = readRepo(
      'packages/vhhealth_core/lib/models/clinical_continuity_action_policy.dart',
    );
    const actionGate = readRepo(
      'packages/vhhealth_core/lib/services/clinical_continuity_action_gate.dart',
    );
    const verifier = readRepo(
      'packages/vhhealth_core/lib/services/clinical_continuity_verifier.dart',
    );
    const actionIds = readRepo(
      'packages/vhhealth_core/lib/services/offline_action_ids.dart',
    );
    const policySource = readRepo(
      'apps/staff/lib/core/services/staff_action_policy_source.dart',
    );
    const policyRepository = readRepo(
      'apps/staff/lib/core/services/staff_action_policy_repository.dart',
    );
    const actionGateway = readRepo(
      'apps/staff/lib/core/services/staff_clinical_action_gateway.dart',
    );

    for (const token of [
      'class ClinicalContinuityActionRule',
      'class VerifiedClinicalContinuityActionPolicy',
    ]) {
      expect(policyModel).toContain(token);
    }

    for (const token of [
      'enum ClinicalContinuityActionGateStage',
      'class ClinicalContinuityActionDecision',
      'class ClinicalContinuityActionGate',
      'OfflineActionIds.isKnown',
    ]) {
      expect(actionGate).toContain(token);
    }

    expect(verifier).toContain(
      'class ClinicalContinuityActionPolicyVerificationResult',
    );
    expect(verifier).toContain(
      'Future<ClinicalContinuityActionPolicyVerificationResult> verifyActionPolicy',
    );

    expect(actionIds).toContain('abstract final class OfflineActionIds');
    expect(actionIds).toContain('static bool isKnown');
    expect(actionIds).toContain('clientTransportFor');

    expect(policySource).toContain('class StaffActionPolicySourcePayload');
    expect(policySource).toContain(
      'abstract interface class StaffActionPolicySource',
    );
    expect(policySource).toContain(
      'Future<StaffActionPolicySourcePayload> fetch',
    );

    expect(policyRepository).toContain('class StaffActionPolicyRepository');
    expect(policyRepository).toContain(
      'VerifiedClinicalContinuityActionPolicy? get verifiedPolicy',
    );
    expect(policyRepository).toContain(
      'ClinicalContinuityActionDecision evaluate',
    );
    expect(policyRepository).toContain('verifyActionPolicy');

    expect(actionGateway).toContain('class StaffClinicalActionGateway');
    expect(actionGateway).toContain('StaffActionPolicyRepository');
    expect(actionGateway).toContain('ClinicalContinuityActionGateStage.persist');
    expect(actionGateway).toContain(
      'ClinicalContinuityActionGateStage.localDraft',
    );
    expect(actionGateway).toContain('OfflineActionIds.');
  });

  it('keeps role policy feature catalog tied to Staff sidebar fallback', () => {
    const policy = readRepo('apps/backend/src/config/rolePolicyGraph.js');
    const rbacRoutes = readRepo('apps/backend/src/routes/infrastructure/rbacRoutes.js');
    const roleConfig = readRepo('apps/staff/lib/core/config/role_config.dart');
    const mainScaffold = readRepo('apps/staff/lib/core/widgets/main_scaffold.dart');

    for (const feature of [
      'front_office_workbench',
      'appointments',
      'patient_records',
      'dental_charting',
      'billing_desk',
      'admissions',
      'bed_board',
      'staff_roster_hub',
      'staff_management',
      'audit_logs',
    ]) {
      expect(policy).toContain(`id: '${feature}'`);
      expect(roleConfig).toContain(`featureId: '${feature}'`);
    }

    expect(roleConfig).toContain('policyFeatureIds');
    expect(mainScaffold).toContain('getRolePolicySnapshot');
    expect(mainScaffold).toContain('policyFeatureIds: _policyFeatureIds');

    const autoRbacMarker = rbacRoutes.indexOf('BASIC RBAC ROUTES');
    // /policy auth is enforced router-level (HEAD-004/CAN-004: `router.use(jwtAuth)`
    // mounts before the route), so the inline jwtAuth was removed — match the
    // current registration form.
    const policyRoute = rbacRoutes.indexOf(
      "router.get('/policy', wrapAsync(rbacController.getPolicy))",
    );
    expect(policyRoute).toBeGreaterThan(-1);
    expect(autoRbacMarker).toBeGreaterThan(policyRoute);
  });
});
