import { CLINICAL_STAFF_ROUTE_ROLES } from './routeRolePolicy.js';
import { canonicalizeJson, hashCanonicalValue } from '../services/downtime/continuityPackCanonical.js';
import { CLINICAL_CONTINUITY_ACTION_SCHEMAS } from '../validators/clinicalContinuityActionSchemas.js';

export const CLINICAL_CONTINUITY_ACTION_CATALOG_SCHEMA_VERSION = 1;
export const CLINICAL_CONTINUITY_ACTION_REGISTRY_SCHEMA_VERSION = 1;
export const CLINICAL_CONTINUITY_ACTION_BINDING_NONE = 'none';
export const CLINICAL_CONTINUITY_NOTE_DRAFT_BINDING_ID = 'emr.note_draft.store/v1';

const C_D3_APPROVAL = Object.freeze({
  countersignedAt: '2026-07-30',
  decisionId: 'C-D3',
  source:
    'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
});

const CLINICAL_DRAFT_ROLES = Object.freeze([...CLINICAL_STAFF_ROUTE_ROLES].sort());

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

function noneActionSchema() {
  return {
    checksum: null,
    id: 'none',
    version: 0
  };
}

function actionSchema(schemaId) {
  const schema = CLINICAL_CONTINUITY_ACTION_SCHEMAS[schemaId];
  if (!schema) throw new Error(`Unknown clinical continuity action schema ${schemaId}`);
  return {
    checksum: schema.checksum,
    id: schema.id,
    version: schema.version
  };
}

function buildAction({
  actionId,
  domain,
  offlineClass,
  clinicalObjectClass,
  captureReady = false,
  replayBindingId = CLINICAL_CONTINUITY_ACTION_BINDING_NONE,
  replayDisposition,
  schemaId = null,
  allowedRoles = [],
  requiredCapabilities = [],
  requiredIdentity,
  cachedSourceMode = 'not_capture_ready',
  cachedSources = [],
  witness = 'not_applicable',
  breakGlass = 'blocked',
  idempotency = 'required_before_capture',
  optimisticConcurrency = 'required_before_capture',
  occurrenceTime = 'required_before_capture',
  lateArrival = 'needs_review',
  sla = 'owner_required_before_capture',
  notifications = 'owner_required_before_capture',
  conflictOwner,
  quarantineOwner
}) {
  const contract = {
    actionId,
    actionSchema: schemaId ? actionSchema(schemaId) : noneActionSchema(),
    actionVersion: 1,
    allowedRoles: [...allowedRoles],
    approvalEvidence: C_D3_APPROVAL,
    breakGlass,
    cachedSourceContract: {
      mode: cachedSourceMode,
      sources: cachedSources
    },
    classification: {
      captureReady,
      clinicalObjectClass,
      offlineClass
    },
    conflictOwnership: {
      owner: conflictOwner,
      outcome: 'needs_review'
    },
    idempotency: {
      contract: idempotency,
      fingerprint: 'rfc8785-jcs-sha256'
    },
    notifications: {
      contract: notifications
    },
    occurrence: {
      lateArrival,
      occurrenceTime
    },
    optimisticConcurrency: {
      contract: optimisticConcurrency
    },
    quarantineOwnership: {
      durableState: 'needs_review',
      owner: quarantineOwner
    },
    replayEndpoint: {
      bindingId: replayBindingId,
      disposition: replayDisposition
    },
    requiredCapabilities: [...requiredCapabilities],
    requiredIdentity,
    scope: {
      client: 'staff',
      domain,
      facilityScoped: true
    },
    sla: {
      contract: sla
    },
    witness
  };
  const canonicalContract = JSON.parse(canonicalizeJson(contract));
  return deepFreeze({
    ...canonicalContract,
    actionChecksum: hashCanonicalValue(canonicalContract)
  });
}

const nursingNoteActions = [
  ['observation', 'observation', 'nursing_governance'],
  ['medication_note', 'mixed_narrative_or_physical_action', 'nursing_and_medication_governance'],
  ['post_procedure', 'physical_action_documentation', 'nursing_and_procedural_governance'],
  ['intake_output', 'observation', 'nursing_and_structured_io_governance'],
  ['patient_complaint', 'observation', 'nursing_and_escalation_governance'],
  ['wound_care', 'physical_action_documentation', 'nursing_and_wound_governance'],
  ['shift_handover', 'observation', 'nursing_handover_governance'],
  ['emergency', 'physical_action_documentation', 'nursing_and_emergency_governance'],
  ['other', 'unbounded', 'clinical_governance']
].map(([suffix, clinicalObjectClass, owner]) =>
  buildAction({
    actionId: `emr.nursing_note.${suffix}.capture`,
    domain: 'emr_nursing_note',
    offlineClass: 'unknown_default_deny',
    clinicalObjectClass,
    replayDisposition: 'generic_authoritative_note_route_denied',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'encounter',
      'capture_session'
    ],
    conflictOwner: owner,
    quarantineOwner: owner
  })
);

export const CLINICAL_CONTINUITY_ACTION_CATALOG = deepFreeze([
  buildAction({
    actionId: 'op.prescription.draft',
    domain: 'op_prescribing',
    offlineClass: 'local_draft_only',
    clinicalObjectClass: 'order_draft',
    replayDisposition: 'authoritative_prescription_create_denied',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'appointment_or_encounter',
      'capture_session'
    ],
    conflictOwner: 'prescribing_and_pharmacy_governance',
    quarantineOwner: 'prescribing_and_pharmacy_governance'
  }),
  buildAction({
    actionId: 'ip.drug_chart.draft',
    domain: 'inpatient_cpoe',
    offlineClass: 'local_draft_only',
    clinicalObjectClass: 'order_draft',
    replayDisposition: 'authoritative_order_create_denied',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'admission',
      'encounter',
      'capture_session'
    ],
    conflictOwner: 'inpatient_prescribing_pharmacy_and_nursing_governance',
    quarantineOwner: 'inpatient_prescribing_pharmacy_and_nursing_governance'
  }),
  buildAction({
    actionId: 'mar.administration.backfill',
    domain: 'medication_administration',
    offlineClass: 'paper_only_backfill',
    clinicalObjectClass: 'physical_action',
    replayDisposition: 'generic_mar_replay_denied',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'admission',
      'mar_administration',
      'paper_item',
      'incident'
    ],
    witness: 'owner_defined_checker_required',
    breakGlass: 'override_bearing_action_blocked_electronic',
    conflictOwner: 'medication_safety_and_nursing_governance',
    quarantineOwner: 'medication_safety_and_nursing_governance'
  }),
  buildAction({
    actionId: 'lab.specimen_collection.backfill',
    domain: 'laboratory_specimen',
    offlineClass: 'paper_only_backfill',
    clinicalObjectClass: 'physical_action',
    replayDisposition: 'generic_specimen_replay_denied',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'investigation',
      'specimen',
      'paper_item',
      'incident'
    ],
    witness: 'owner_defined_checker_required',
    conflictOwner: 'laboratory_and_phlebotomy_governance',
    quarantineOwner: 'laboratory_and_phlebotomy_governance'
  }),
  buildAction({
    actionId: 'blood.transfusion_verification.backfill',
    domain: 'blood_bank',
    offlineClass: 'paper_only_backfill',
    clinicalObjectClass: 'physical_action',
    replayDisposition: 'generic_transfusion_replay_denied',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'encounter',
      'blood_request',
      'blood_unit',
      'paper_item',
      'incident'
    ],
    witness: 'two_distinct_currently_authorized_verifiers',
    conflictOwner: 'blood_bank_and_transfusion_safety_governance',
    quarantineOwner: 'blood_bank_and_transfusion_safety_governance'
  }),
  ...nursingNoteActions,
  buildAction({
    actionId: 'vitals.capture',
    domain: 'vital_signs',
    offlineClass: 'queueable_capture',
    clinicalObjectClass: 'observation',
    replayDisposition: 'current_authoritative_vitals_route_denied_pending_contract',
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'encounter_or_admission',
      'capture_session'
    ],
    cachedSourceMode: 'required_before_capture',
    cachedSources: [
      {
        maxAgeMinutes: 15,
        sourceId: 'latest_vitals',
        staleAtMinutes: 15
      }
    ],
    conflictOwner: 'nursing_and_vitals_governance',
    quarantineOwner: 'nursing_and_vitals_governance'
  }),
  buildAction({
    actionId: 'emr.nursing_note.draft.store',
    domain: 'emr_nursing_note_draft',
    offlineClass: 'queueable_capture',
    clinicalObjectClass: 'draft',
    captureReady: true,
    replayBindingId: CLINICAL_CONTINUITY_NOTE_DRAFT_BINDING_ID,
    replayDisposition: 'private_draft_storage_only',
    schemaId: 'emr.nursing_note.draft.store/v1',
    allowedRoles: CLINICAL_DRAFT_ROLES,
    requiredCapabilities: ['nursing_governance'],
    requiredIdentity: ['actor', 'tenant', 'facility', 'patient', 'capture_session'],
    cachedSourceMode: 'required',
    cachedSources: [
      {
        maxAgeMinutes: 1_440,
        sourceId: 'patient_identity',
        staleAtMinutes: 15
      }
    ],
    idempotency: 'stable_client_event_and_fingerprint_required',
    optimisticConcurrency: 'draft_revision_compare_and_swap_required',
    occurrenceTime: 'capture_time_required',
    lateArrival: 'explicit_compatibility_or_needs_review',
    sla: 'no_clinical_sla_draft_storage_only',
    notifications: 'none',
    conflictOwner: 'nursing_privacy_and_security_governance',
    quarantineOwner: 'nursing_privacy_and_security_governance'
  }),
  buildAction({
    actionId: 'emr.op_note.draft.store',
    domain: 'emr_op_note_draft',
    offlineClass: 'queueable_capture',
    clinicalObjectClass: 'draft',
    captureReady: true,
    replayBindingId: CLINICAL_CONTINUITY_NOTE_DRAFT_BINDING_ID,
    replayDisposition: 'private_draft_storage_only',
    schemaId: 'emr.op_note.draft.store/v1',
    allowedRoles: CLINICAL_DRAFT_ROLES,
    requiredCapabilities: ['op_flow'],
    requiredIdentity: [
      'actor',
      'tenant',
      'facility',
      'patient',
      'appointment_or_encounter',
      'capture_session'
    ],
    cachedSourceMode: 'required',
    cachedSources: [
      {
        maxAgeMinutes: 1_440,
        sourceId: 'patient_identity',
        staleAtMinutes: 15
      }
    ],
    idempotency: 'stable_client_event_and_fingerprint_required',
    optimisticConcurrency: 'draft_revision_compare_and_swap_required',
    occurrenceTime: 'capture_time_required',
    lateArrival: 'explicit_compatibility_or_needs_review',
    sla: 'no_clinical_sla_draft_storage_only',
    notifications: 'none',
    conflictOwner: 'op_privacy_and_security_governance',
    quarantineOwner: 'op_privacy_and_security_governance'
  })
]);

export const CLINICAL_CONTINUITY_ACTION_IDS = Object.freeze(
  CLINICAL_CONTINUITY_ACTION_CATALOG.map(action => action.actionId)
);

export const CLINICAL_CONTINUITY_ACTIONS_BY_ID = Object.freeze(
  Object.fromEntries(CLINICAL_CONTINUITY_ACTION_CATALOG.map(action => [action.actionId, action]))
);

export const CLINICAL_CONTINUITY_UNKNOWN_ACTION_FALLBACK = deepFreeze({
  actionId: 'unknown',
  disposition: 'fail_closed',
  executable: false
});

export const CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES = deepFreeze([
  {
    actionIds: ['op.prescription.draft'],
    method: 'POST',
    routePattern: '/api/v1/prescriptions/create'
  },
  {
    actionIds: ['ip.drug_chart.draft'],
    method: 'POST',
    routePattern: '/api/v1/emr/orders'
  },
  {
    actionIds: ['mar.administration.backfill'],
    method: 'POST',
    routePattern: '/api/v1/clinical/mar/:id/administer-with-scan'
  },
  {
    actionIds: ['lab.specimen_collection.backfill'],
    method: 'POST',
    routePattern: '/api/v1/lab/samples/:investigationId/collect'
  },
  {
    actionIds: ['blood.transfusion_verification.backfill'],
    method: 'POST',
    routePattern: '/api/v1/blood-bank/:id/verify-bedside'
  },
  {
    actionIds: nursingNoteActions.map(action => action.actionId),
    method: 'POST',
    routePattern: '/api/v1/emr/notes'
  },
  {
    actionIds: ['vitals.capture'],
    method: 'POST',
    routePattern: '/api/v1/health/records'
  }
]);
