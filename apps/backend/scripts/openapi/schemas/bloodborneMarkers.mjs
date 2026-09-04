// apps/backend/scripts/openapi/schemas/bloodborneMarkers.mjs
//
// Contract for the patient blood-borne marker read/void surface
// (src/routes/clinical/bloodborneMarkerRoutes.js). Field shapes are taken from
// what the service actually emits — normalizeMarkerRow() in
// bloodborneMarkerService.js for the row, computeReuseStatus() in
// bloodborneMarkerRules.js for the status — not from the table alone.
import { envelope } from './_helpers.mjs';

const MARKERS = ['hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other'];
const RESULTS = ['reactive', 'non_reactive', 'indeterminate', 'pending'];
const SOURCES = ['lab_result', 'external_report', 'clinical_declaration'];
const STATUSES = ['restricted', 'unknown', 'clear'];

const nullableString = { type: 'string', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };

const idempotencyHeaderParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' }
};

export const schemas = {
  // Every column in MARKER_SELECT is returned on every row, so the whole
  // column set is required; only the values are nullable. `id` and
  // `lab_result_id` are bigint columns that normalizeMarkerRow() coerces to
  // Number before serialisation, and `tested_on` is passed through isoDate()
  // to a YYYY-MM-DD string.
  BloodborneMarker: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'tenant_id',
      'patient_uid',
      'marker',
      'marker_label',
      'result',
      'tested_on',
      'source',
      'lab_result_id',
      'evidence',
      'recorded_by',
      'recorded_at',
      'voided_at',
      'voided_by',
      'void_reason',
      'notes'
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_uid: { type: 'string', format: 'uuid' },
      marker: { type: 'string', enum: MARKERS },
      marker_label: {
        ...nullableString,
        description: "Free-text label, set only when marker is 'other'."
      },
      result: { type: 'string', enum: RESULTS },
      tested_on: { type: 'string', format: 'date' },
      source: { type: 'string', enum: SOURCES },
      lab_result_id: { type: 'integer', nullable: true },
      evidence: { type: 'object', additionalProperties: true },
      recorded_by: { type: 'string', format: 'uuid' },
      recorded_at: { type: 'string', format: 'date-time' },
      voided_at: nullableDateTime,
      voided_by: nullableUuid,
      void_reason: nullableString,
      notes: nullableString
    }
  },

  // One entry per distinct marker still on record — the latest non-voided row
  // for that marker (per label for 'other'). computeReuseStatus() emits all
  // seven keys on every entry: `label` is null for every marker except
  // 'other', and `age_days` is null when tested_on cannot be read as a date.
  // A negative age_days means the result is dated in the future, which never
  // counts as within_window.
  BloodborneReuseMarkerSummary: {
    type: 'object',
    additionalProperties: false,
    required: ['marker', 'label', 'result', 'tested_on', 'source', 'age_days', 'within_window'],
    properties: {
      marker: { type: 'string', enum: MARKERS },
      label: nullableString,
      result: { type: 'string', enum: RESULTS },
      tested_on: { type: 'string', format: 'date' },
      source: { type: 'string', enum: SOURCES },
      age_days: { type: 'integer', nullable: true },
      within_window: { type: 'boolean' }
    }
  },

  // `reasons` is never empty: 'restricted' lists one reason per reactive
  // marker, 'clear' carries the single all-clear statement, and 'unknown'
  // always carries at least one reason.
  BloodborneReuseStatus: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'reasons', 'markers', 'validity_days', 'evaluated_at'],
    properties: {
      status: {
        type: 'string',
        enum: STATUSES,
        description:
          "'restricted' whenever any non-voided reactive row exists for any marker, at any age — a reactive result latches and is cleared only by voiding the row. 'clear' requires the latest HIV, HBsAg and HCV rows to all be non-reactive within validity_days. Anything else is 'unknown'."
      },
      reasons: { type: 'array', minItems: 1, items: { type: 'string' } },
      markers: {
        type: 'array',
        items: { $ref: '#/components/schemas/BloodborneReuseMarkerSummary' }
      },
      validity_days: { type: 'integer', minimum: 1, maximum: 365 },
      evaluated_at: { type: 'string', format: 'date-time' }
    }
  },

  BloodborneMarkerListData: {
    type: 'object',
    additionalProperties: false,
    required: ['markers', 'reuse_status'],
    properties: {
      markers: { type: 'array', items: { $ref: '#/components/schemas/BloodborneMarker' } },
      reuse_status: { $ref: '#/components/schemas/BloodborneReuseStatus' }
    }
  },
  BloodborneMarkerListResponse: envelope('BloodborneMarkerListData'),

  BloodborneMarkerVoidRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
  },
  BloodborneMarkerVoidData: {
    type: 'object',
    additionalProperties: false,
    required: ['marker'],
    properties: { marker: { $ref: '#/components/schemas/BloodborneMarker' } }
  },
  BloodborneMarkerVoidResponse: envelope('BloodborneMarkerVoidData')
};

export const operations = {
  'GET /api/v1/bloodborne-markers/patient/{patientUid}': {
    description:
      'Patient blood-borne marker rows (latest tested_on first) and the reuse-restriction status derived from them. Reactive rows never lapse; non-reactive rows are relied on for validity_days (default 90). Voided rows are excluded from both the list and the resolver unless include_voided=true, which adds them to `markers` only — the resolver always ignores them.',
    pathParameters: { patientUid: { type: 'string', format: 'uuid' } },
    parameters: [
      {
        name: 'validity_days',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 365, default: 90 }
      },
      { name: 'include_voided', in: 'query', required: false, schema: { type: 'boolean' } }
    ],
    response: 'BloodborneMarkerListResponse'
  },
  'POST /api/v1/bloodborne-markers/patient/{patientUid}/markers/{id}/void': {
    description:
      'Voids one marker row (entered in error). The route is mounted with requireIdempotencyKey({ required: true, scope: bloodborne_marker_void }), so the Idempotency-Key header is not optional — omitting it is a hard 400. A voided row is ignored by the reuse resolver and cannot be voided again (409 BLOODBORNE_MARKER_ALREADY_VOIDED); an id that is not this patient’s live or voided row is 404 BLOODBORNE_MARKER_NOT_FOUND. There is deliberately no create route: rows are written by the lab sign-off hook and the cath readiness checklist.',
    pathParameters: {
      patientUid: { type: 'string', format: 'uuid' },
      id: { type: 'integer', minimum: 1 }
    },
    parameters: [idempotencyHeaderParameter],
    request: 'BloodborneMarkerVoidRequest',
    response: 'BloodborneMarkerVoidResponse'
  }
};
