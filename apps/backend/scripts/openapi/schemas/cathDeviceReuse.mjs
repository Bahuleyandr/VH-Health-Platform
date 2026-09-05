// apps/backend/scripts/openapi/schemas/cathDeviceReuse.mjs
//
// Cath reprocessable-device register: the post-use disposition on a cath case,
// the case-pinned device lookup and infection-control history, the CSSD device
// queue, and the per-tenant reprocessing settings/policies admin surface.
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md
//
// Device shapes here mirror cathDeviceReuseService.js exactly:
//   - CathReprocessableDevice = DEVICE_SELECT (27 device columns + the four
//     catalogue columns the join adds) after normalizeDevice();
//   - CathPostUseOptions = computePostUseOptions()'s return;
//   - device_tag is the DB's generated column
//     ('RP' || lpad(id, GREATEST(8, len(id)), '0')), so outputs are RP + 8..19
//     digits; tag INPUTS additionally accept lower case because
//     normalizeDeviceTag() upper-cases before matching DEVICE_TAG_PATTERN.

import { envelope } from './_helpers.mjs';

const CATEGORIES = ['stent', 'balloon', 'guidewire', 'catheter', 'sheath', 'closure_device', 'pacemaker', 'lead', 'other'];
const DEVICE_STATUSES = ['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded'];
const CYCLE_TYPES = ['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other'];
const FUNCTION_CHECKS = ['not_required', 'pass', 'fail'];
const DISCARD_REASONS = ['max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed', 'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other'];
const POST_USE_DISPOSITIONS = ['sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles', 'discarded_wasted', 'discarded_other', 'not_reprocessable'];
const REUSE_STATUSES = ['restricted', 'unknown', 'clear'];
const DEVICE_LABEL_FORMATS = ['pdf', 'json'];
const REACTIVE_PATIENT_RULES = ['discard', 'override_allowed'];
const UNKNOWN_SEROLOGY_RULES = ['warn', 'block_return'];

// Output tags come straight from the generated column, so they are always
// upper case; inputs are case-insensitive (normalizeDeviceTag upper-cases).
const DEVICE_TAG_OUT_PATTERN = '^RP[0-9]{8,19}$';
const DEVICE_TAG_IN_PATTERN = '^[Rr][Pp][0-9]{8,19}$';

const nullableString = { type: 'string', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const BIGINT_WIRE = {
  oneOf: [
    { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    {
      type: 'string',
      pattern: '^[1-9][0-9]*$',
      description: 'Decimal string when the identifier exceeds the JavaScript safe-integer range.'
    }
  ]
};
const idempotencyHeaderParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' }
};
const queryParameter = (name, schema) => ({ name, in: 'query', required: false, schema });

const device = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'tenant_id', 'facility_id', 'catalog_item_id', 'device_tag', 'origin_usage_id', 'origin_unit_index',
    'cycle_count', 'max_cycles_snapshot', 'status', 'current_usage_id', 'exposure_flag', 'exposure_markers',
    'last_reprocessed_at', 'last_reprocessed_by', 'last_cycle_type', 'last_function_check', 'quarantine_reason',
    'quarantined_at', 'discard_reason', 'discard_note', 'discarded_at', 'discarded_by', 'created_by',
    'created_at', 'updated_at', 'metadata', 'item_name', 'category', 'manufacturer', 'model'
  ],
  properties: {
    id: { type: 'integer', minimum: 1 },
    tenant_id: { type: 'string', format: 'uuid' },
    facility_id: { type: 'integer', minimum: 1 },
    catalog_item_id: { type: 'integer', minimum: 1 },
    device_tag: { type: 'string', pattern: DEVICE_TAG_OUT_PATTERN },
    origin_usage_id: { type: 'integer', minimum: 1 },
    origin_unit_index: { type: 'integer', minimum: 1 },
    cycle_count: { type: 'integer', minimum: 0 },
    max_cycles_snapshot: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: DEVICE_STATUSES },
    current_usage_id: nullableInteger,
    exposure_flag: { type: 'boolean' },
    exposure_markers: { type: 'array', items: { type: 'string' } },
    last_reprocessed_at: nullableDateTime,
    last_reprocessed_by: nullableUuid,
    last_cycle_type: { type: 'string', enum: CYCLE_TYPES, nullable: true },
    last_function_check: { type: 'string', enum: FUNCTION_CHECKS, nullable: true },
    quarantine_reason: nullableString,
    quarantined_at: nullableDateTime,
    discard_reason: { type: 'string', enum: DISCARD_REASONS, nullable: true },
    discard_note: nullableString,
    discarded_at: nullableDateTime,
    discarded_by: nullableUuid,
    created_by: { type: 'string', format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
    item_name: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    manufacturer: nullableString,
    model: nullableString
  }
};

// ONE ROW OF THE CSSD QUEUE = the device row plus the two columns
// listDevices joins in and no other device surface returns. Spelled out rather
// than composed with allOf: every device schema here is
// additionalProperties:false, and an allOf of two closed objects is a schema
// nothing can satisfy.
//
// status_changed_at is derived, not stored — the register has no such column
// and updated_at moves on the late-reactive exposure stamp, which changes no
// status. See DEVICE_QUEUE_SELECT in cathDeviceReuseService.js.
const queueItem = {
  type: 'object',
  additionalProperties: false,
  required: [...device.required, 'facility_name', 'status_changed_at'],
  properties: {
    ...device.properties,
    facility_name: { type: 'string' },
    status_changed_at: { type: 'string', format: 'date-time' }
  }
};

// getReprocessingSettings() returns the unconfigured default row with every
// SETTINGS_SELECT column present, so `configured` is the only signal that the
// tenant has never saved a policy — never a missing key.
const settings = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tenant_id', 'reactive_patient_rule', 'unknown_serology_rule', 'serology_validity_days',
    'reviewed_by', 'reviewed_at', 'updated_by', 'created_at', 'updated_at', 'configured'
  ],
  properties: {
    tenant_id: { type: 'string', format: 'uuid' },
    reactive_patient_rule: { type: 'string', enum: REACTIVE_PATIENT_RULES },
    unknown_serology_rule: { type: 'string', enum: UNKNOWN_SEROLOGY_RULES },
    serology_validity_days: { type: 'integer', minimum: 1, maximum: 365 },
    reviewed_by: nullableUuid,
    reviewed_at: nullableDateTime,
    updated_by: nullableUuid,
    created_at: nullableDateTime,
    updated_at: nullableDateTime,
    configured: { type: 'boolean' }
  }
};

// listCategoryPolicies() always returns one row per CATH_CATEGORIES entry —
// a stored row, or the all-false default — so the list is never sparse.
const policy = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tenant_id', 'category', 'reprocessable', 'max_cycles', 'allowed_cycle_types',
    'function_check_required', 'updated_by', 'created_at', 'updated_at'
  ],
  properties: {
    tenant_id: { type: 'string', format: 'uuid' },
    category: { type: 'string', enum: CATEGORIES },
    reprocessable: { type: 'boolean' },
    max_cycles: { type: 'integer', minimum: 1, maximum: 50, nullable: true },
    allowed_cycle_types: { type: 'array', items: { type: 'string', enum: CYCLE_TYPES } },
    function_check_required: { type: 'boolean' },
    updated_by: nullableUuid,
    created_at: nullableDateTime,
    updated_at: nullableDateTime
  }
};

// computePostUseOptions() spreads `base` on every path, so all eight keys are
// always present. reason_codes is an open string list on purpose: the codes are
// a UI vocabulary that grows with the rules (wasted, already_recorded,
// not_reprocessable, max_cycles_reached, device_exposure_flagged,
// bloodborne_restricted, bloodborne_restricted_override, serology_required,
// serology_unknown), and pinning it here would make every new rule a breaking
// contract change.
const postUseOptions = {
  type: 'object',
  additionalProperties: false,
  required: ['dispositions', 'requires_acknowledgement', 'exposure', 'discard_reason', 'blocked_code', 'reason_codes', 'units_max'],
  properties: {
    dispositions: { type: 'array', items: { type: 'string', enum: ['reprocess', 'discard'] } },
    requires_acknowledgement: { type: 'boolean' },
    exposure: { type: 'boolean' },
    discard_reason: { type: 'string', enum: DISCARD_REASONS, nullable: true },
    blocked_code: nullableString,
    reason_codes: { type: 'array', items: { type: 'string' } },
    units_max: { type: 'integer', minimum: 0 }
  }
};

// Published enum vocabularies, exported so
// src/tests/unit/cathDeviceReuseOpenApiSource.test.js can diff them against the
// service's own frozen constants — two copies of a vocabulary drift silently
// otherwise, and either direction is a contract lie.
export const ENUMS = {
  CATEGORIES,
  DEVICE_STATUSES,
  DEVICE_LABEL_FORMATS,
  CYCLE_TYPES,
  FUNCTION_CHECKS,
  DISCARD_REASONS,
  POST_USE_DISPOSITIONS,
  REACTIVE_PATIENT_RULES,
  UNKNOWN_SEROLOGY_RULES,
  DEVICE_TAG_OUT_PATTERN,
  DEVICE_TAG_IN_PATTERN
};

export const schemas = {
  CathReprocessableDevice: device,
  CssdDeviceQueueItem: queueItem,
  CathReprocessingSettings: settings,
  CathReprocessingCategoryPolicy: policy,
  CathPostUseOptions: postUseOptions,

  CathPostUseRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['disposition'],
    properties: {
      disposition: { type: 'string', enum: ['reprocess', 'discard'] },
      // Bounded by the recorded quantity AND by an absolute cap of 50 devices
      // per post-use record (cathDeviceReuseService.POST_USE_UNITS_CAP): each
      // unit is an INSERT + lock + audit round trip inside one transaction.
      units: { type: 'integer', minimum: 1, maximum: 50 },
      discard_reason: { type: 'string', enum: DISCARD_REASONS },
      discard_note: { type: 'string', maxLength: 2000 },
      acknowledgement: {
        type: 'object',
        additionalProperties: false,
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
      }
    }
  },
  // recordPostUse() returns the five required keys on every path. The two
  // optional flags are the non-ordinary outcomes: `idempotent_replay` on a
  // same-key replay of an already-dispositioned row, and
  // `device_already_discarded` when CSSD discarded the device while it was
  // still in the case and the row is settled from the device's own reason.
  CathPostUseResultData: {
    type: 'object',
    additionalProperties: false,
    required: ['usage_id', 'case_id', 'disposition', 'units', 'devices', 'restriction_status'],
    properties: {
      usage_id: { type: 'integer', minimum: 1 },
      case_id: { type: 'integer', minimum: 1 },
      disposition: { type: 'string', enum: POST_USE_DISPOSITIONS },
      units: nullableInteger,
      devices: { type: 'array', items: { $ref: '#/components/schemas/CathReprocessableDevice' } },
      restriction_status: { type: 'string', enum: REUSE_STATUSES },
      idempotent_replay: { type: 'boolean' },
      device_already_discarded: { type: 'boolean' }
    }
  },
  CathPostUseResponse: envelope('CathPostUseResultData'),

  CathDeviceLookupData: {
    type: 'object',
    additionalProperties: false,
    required: ['device', 'reprocessable', 'cycles_remaining', 'exposure_rule', 'requires_acknowledgement', 'blocked'],
    properties: {
      device: { $ref: '#/components/schemas/CathReprocessableDevice' },
      reprocessable: { type: 'boolean' },
      cycles_remaining: { type: 'integer', minimum: 0 },
      exposure_rule: { type: 'string', enum: REACTIVE_PATIENT_RULES },
      requires_acknowledgement: { type: 'boolean' },
      blocked: { type: 'boolean' }
    }
  },
  CathDeviceLookupResponse: envelope('CathDeviceLookupData'),

  CathDeviceHistoryData: {
    type: 'object',
    additionalProperties: false,
    required: ['device', 'uses', 'events'],
    properties: {
      device: { $ref: '#/components/schemas/CathReprocessableDevice' },
      uses: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['usage_id', 'case_id', 'patient_uid', 'used_at', 'reuse_cycle', 'post_use_disposition', 'kind'],
          properties: {
            usage_id: { type: 'integer', minimum: 1 },
            case_id: { type: 'integer', minimum: 1 },
            patient_uid: { type: 'string', format: 'uuid' },
            used_at: { type: 'string', format: 'date-time' },
            reuse_cycle: nullableInteger,
            post_use_disposition: { type: 'string', enum: POST_USE_DISPOSITIONS, nullable: true },
            kind: { type: 'string', enum: ['first_use', 'reuse'] }
          }
        }
      },
      events: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'actor_uid', 'metadata', 'created_at'],
          properties: {
            action: { type: 'string' },
            actor_uid: nullableUuid,
            metadata: { type: 'object', additionalProperties: true },
            created_at: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  },
  CathDeviceHistoryResponse: envelope('CathDeviceHistoryData'),

  // The CSSD router's `wrap` puts the service return value directly in `data`,
  // so these two envelopes are NOT the `<Name>Data` shape used elsewhere.
  CssdDeviceListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { type: 'array', items: { $ref: '#/components/schemas/CssdDeviceQueueItem' } },
      requestId: { type: 'string', nullable: true }
    }
  },
  CssdDeviceResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: '#/components/schemas/CathReprocessableDevice' },
      requestId: { type: 'string', nullable: true }
    }
  },
  // The printed CSSD label. Mirrors DEVICE_LABEL_FIELDS in
  // cathDeviceReuseService.js exactly — device IDENTITY only. The register's
  // exposure_flag / exposure_markers are deliberately absent: they name a
  // blood-borne marker a PREVIOUS patient tested reactive for, and this
  // artefact leaves the department stuck to the device with no role gate in
  // front of it.
  CssdDeviceLabel: {
    type: 'object',
    additionalProperties: false,
    required: ['device_tag', 'category', 'catalogue_item', 'reuse_cycle', 'max_cycles', 'facility_name', 'printed_at'],
    properties: {
      device_tag: { type: 'string', pattern: DEVICE_TAG_OUT_PATTERN },
      category: { type: 'string', enum: CATEGORIES },
      catalogue_item: { type: 'string' },
      reuse_cycle: { type: 'integer', minimum: 0 },
      max_cycles: { type: 'integer', minimum: 1 },
      // facilities.display_name is NOT NULL and the device's
      // (tenant_id, facility_id) foreign key is RESTRICT, so the inner join
      // always names a facility.
      facility_name: { type: 'string' },
      printed_at: { type: 'string', format: 'date-time' }
    }
  },
  CssdDeviceLabelResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: '#/components/schemas/CssdDeviceLabel' },
      requestId: { type: 'string', nullable: true }
    }
  },
  CssdDeviceReprocessedRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['cycle_type'],
    properties: {
      cycle_type: { type: 'string', enum: CYCLE_TYPES },
      function_check_result: { type: 'string', enum: FUNCTION_CHECKS },
      note: { type: 'string', maxLength: 2000 }
    }
  },
  CssdDeviceReasonRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
  },
  CssdDeviceNoteRequest: {
    type: 'object',
    additionalProperties: false,
    properties: { note: { type: 'string', maxLength: 500 } }
  },
  CssdDeviceDiscardRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', enum: DISCARD_REASONS },
      note: { type: 'string', maxLength: 2000 }
    }
  },

  CathReprocessingSettingsData: {
    type: 'object',
    additionalProperties: false,
    required: ['settings'],
    properties: { settings: { $ref: '#/components/schemas/CathReprocessingSettings' } }
  },
  CathReprocessingSettingsResponse: envelope('CathReprocessingSettingsData'),
  CathReprocessingSettingsUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reactive_patient_rule: { type: 'string', enum: REACTIVE_PATIENT_RULES },
      unknown_serology_rule: { type: 'string', enum: UNKNOWN_SEROLOGY_RULES },
      serology_validity_days: { type: 'integer', minimum: 1, maximum: 365 }
    }
  },

  CathReprocessingPoliciesData: {
    type: 'object',
    additionalProperties: false,
    required: ['policies', 'count'],
    properties: {
      policies: { type: 'array', items: { $ref: '#/components/schemas/CathReprocessingCategoryPolicy' } },
      count: { type: 'integer', minimum: 0 }
    }
  },
  CathReprocessingPoliciesResponse: envelope('CathReprocessingPoliciesData'),
  CathReprocessingPoliciesUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['policies'],
    properties: {
      policies: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'reprocessable'],
          properties: {
            category: { type: 'string', enum: CATEGORIES },
            reprocessable: { type: 'boolean' },
            max_cycles: { type: 'integer', minimum: 1, maximum: 50, nullable: true },
            allowed_cycle_types: { type: 'array', items: { type: 'string', enum: CYCLE_TYPES } },
            function_check_required: { type: 'boolean' }
          }
        }
      }
    }
  }
};

export const operations = {
  'POST /api/v1/cath-lab/cases/{id}/consumables/{usageId}/post-use': {
    description:
      'Records what happened to a consumable after the case: reprocess (mints register rows for a first-use row, returns a reused device to CSSD) or discard. The allowed dispositions come from allowed_post_use on the consumables listing; anything outside that set is a 409 carrying the reason codes. Requires Idempotency-Key (scope cath_consumable_post_use) — a replay with the same key returns the recorded result with idempotent_replay true.',
    pathParameters: { id: BIGINT_WIRE, usageId: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    request: 'CathPostUseRequest',
    responseStatus: 201,
    response: 'CathPostUseResponse'
  },
  'GET /api/v1/cath-lab/devices/lookup': {
    description:
      'Device state for the capture sheet, pinned to the case facility: a device belonging to another facility is reported as not found rather than described. Carries no patient identity, but the device row does carry exposure_flag and exposure_markers — the blood-borne markers a PREVIOUS patient tested reactive for.',
    parameters: [
      { name: 'case_id', in: 'query', required: true, schema: BIGINT_WIRE },
      { name: 'tag', in: 'query', required: true, schema: { type: 'string', pattern: DEVICE_TAG_IN_PATTERN } }
    ],
    response: 'CathDeviceLookupResponse'
  },
  'GET /api/v1/cath-lab/devices/{deviceId}/history': {
    description:
      'Every use of a device (the patients it touched included) and its register events, for infection-control lookback. Requires a cath-lab WORKFLOW role, not merely report read. PHI with no single patient subject, so the mount logger records patient_id = NULL and the route writes one hipaa_access_log row per distinct patient in the answer instead (capped at 25).',
    pathParameters: { deviceId: BIGINT_WIRE },
    response: 'CathDeviceHistoryResponse'
  },

  'GET /api/v1/cssd/devices': {
    description: 'CSSD reprocessable cath device queue, ordered by the work that is waiting first. Each row is the device register row plus the facility it is waiting at and status_changed_at — when the device last MOVED, derived from its transition audit trail rather than from updated_at, which the late-reactive exposure stamp moves without a status change. Carries no patient data.',
    parameters: [
      queryParameter('status', { type: 'string', enum: DEVICE_STATUSES }),
      queryParameter('facility_id', { type: 'integer', minimum: 1 }),
      queryParameter('limit', { type: 'integer', minimum: 1, maximum: 500 })
    ],
    response: 'CssdDeviceListResponse'
  },
  'GET /api/v1/cssd/devices/{id}/label': {
    description:
      'The printed CSSD label for one device: a 100 x 50 mm PDF carrying the device tag as large monospace text and as a Code 39 barcode, plus the catalogue item, category, cycle counter and facility. ?format=json returns the same seven fields as JSON. A read, so it claims no idempotency key; a reprint is not a second event. The label carries NO patient data and NO serology — the register exposure columns are deliberately not on it — so this path writes no PHI access log, only a cssd.device.label_printed audit row.',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [queryParameter('format', { type: 'string', enum: DEVICE_LABEL_FORMATS, default: 'pdf' })],
    // Declared through additionalResponses because ONE 200 carries TWO media
    // types here, and the overlay's `response` key models a single one. The
    // JSON variant is what the generated clients type; the PDF is the default
    // the browser opens.
    additionalResponses: {
      200: {
        description: 'The device label, as a PDF by default or as JSON on ?format=json.',
        content: {
          'application/pdf': { schema: { type: 'string', format: 'binary' } },
          'application/json': { schema: { $ref: '#/components/schemas/CssdDeviceLabelResponse' } }
        }
      }
    }
  },
  'POST /api/v1/cssd/devices/{id}/receive': {
    description: 'Receives a device into CSSD (awaiting_reprocessing to in_cssd). Requires Idempotency-Key (scope cssd_device_transition).',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    response: 'CssdDeviceResponse'
  },
  'POST /api/v1/cssd/devices/{id}/reprocessed': {
    description: 'Records a completed reprocessing cycle. A failed function check discards the device instead of returning it to available. Requires Idempotency-Key (scope cssd_device_transition).',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    request: 'CssdDeviceReprocessedRequest',
    response: 'CssdDeviceResponse'
  },
  'POST /api/v1/cssd/devices/{id}/quarantine': {
    description: 'Quarantines a device pending review. Requires Idempotency-Key (scope cssd_device_transition).',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    request: 'CssdDeviceReasonRequest',
    response: 'CssdDeviceResponse'
  },
  'POST /api/v1/cssd/devices/{id}/release': {
    description: 'Releases a quarantined device back to the reprocessing queue. Requires Idempotency-Key (scope cssd_device_transition).',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    request: 'CssdDeviceNoteRequest',
    response: 'CssdDeviceResponse'
  },
  'POST /api/v1/cssd/devices/{id}/discard': {
    description: 'Permanently discards a device with a reason from the register vocabulary. Requires Idempotency-Key (scope cssd_device_transition).',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    request: 'CssdDeviceDiscardRequest',
    response: 'CssdDeviceResponse'
  },

  'GET /api/v1/cath-reprocessing/settings': {
    description: 'Per-tenant device reuse rules. Mounted at /api/v1/cath-reprocessing for QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN and SUPER_ADMIN.',
    response: 'CathReprocessingSettingsResponse'
  },
  'PUT /api/v1/cath-reprocessing/settings': {
    description: 'Saves the per-tenant device reuse rules. Mounted at /api/v1/cath-reprocessing for QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN and SUPER_ADMIN. Requires Idempotency-Key (scope cath_reprocessing_policy).',
    parameters: [idempotencyHeaderParameter],
    request: 'CathReprocessingSettingsUpdateRequest',
    response: 'CathReprocessingSettingsResponse'
  },
  'GET /api/v1/cath-reprocessing/policies': {
    description: 'One policy row per consumable category, defaulted to not reprocessable where the tenant has saved nothing. Mounted at /api/v1/cath-reprocessing for QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN and SUPER_ADMIN.',
    response: 'CathReprocessingPoliciesResponse'
  },
  'PUT /api/v1/cath-reprocessing/policies': {
    description: 'Upserts category reprocessing policies. Implant categories can never be reprocessable, a reprocessable category needs max_cycles and at least one allowed cycle type, and a category may appear at most once. Mounted at /api/v1/cath-reprocessing for QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN and SUPER_ADMIN. Requires Idempotency-Key (scope cath_reprocessing_policy).',
    parameters: [idempotencyHeaderParameter],
    request: 'CathReprocessingPoliciesUpdateRequest',
    response: 'CathReprocessingPoliciesResponse'
  },
  'GET /api/v1/cath-reprocessing/devices/{deviceId}/history': {
    description:
      'The same device history the cath router serves, on the governance mount so infection control can open the device tags named in its own exposure notifications without holding a cath-lab workflow role. Mounted at /api/v1/cath-reprocessing for QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN and SUPER_ADMIN. Writes one hipaa_access_log row per distinct patient in the answer.',
    pathParameters: { deviceId: BIGINT_WIRE },
    response: 'CathDeviceHistoryResponse'
  }
};
