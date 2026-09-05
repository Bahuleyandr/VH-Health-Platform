// apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs
//
// Pre-procedure LAB readiness for a cath case: the seven items the checklist
// resolves from the patient's own lab rows, the four actions that can move
// them (order the missing, record an outside value, waive, un-waive), and the
// tenant policy that decides what "ready" means.
// Spec: docs/superpowers/plans/2026-09-04-cath-lab-readiness.md
//
// Every shape here mirrors cathLabReadinessService.js exactly, and is PINNED to
// it by src/tests/unit/cathLabReadinessOpenApiSource.test.js, which drives the
// real resolver and the real refresh (with a stub db) and compares key sets —
// the schemas are additionalProperties:false, so a key the service adds and
// this file does not declare is a response that violates its own contract.
//
//   - CathLabReadinessItem  = resolveItemState()'s return + `required`, which
//     refreshCaseLabReadiness adds from the tenant settings. Every key is
//     always present (the resolver spreads a full `base` on every branch), so
//     every key is required, and the ones with nothing to say are null.
//   - CathLabReadiness      = refreshCaseLabReadiness()'s return. No
//     `_missing_items`: the service does not emit one.
//   - CathLabReadinessSettings = getReadinessSettings()'s return, which has TWO
//     shapes — a configured tenant's row (with updated_by/created_at/updated_at)
//     and the compiled-in defaults for a tenant that has never saved one (which
//     carries none of the three). The intersection is what is required.
//
// Identifier widths: case_id, lab_result_id, investigation_id and specimen_id
// all reach the wire as JSON numbers, never as the decimal-string half of a
// bigint union — the service passes cath_lab_cases.id through num() (BigInt to
// Number) and the other three through Number(), and the three lab-side columns
// are int4 (they are bound ::int on the way in).

import { envelope } from './_helpers.mjs';

// The service's ITEM_CODES / ITEM_STATES, in the order it spells them.
const ITEMS = ['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv'];
const STATES = [
  'result_final', 'result_preliminary', 'external_recorded', 'sample_sent_awaiting_result',
  'ordered_awaiting_sample', 'not_ordered', 'stale', 'waived'
];
const SOURCES = ['lab_result', 'external', 'waiver'];
// What orderCodesCovering() can emit: each item's FIRST orderCode, deduped, in
// placement order. CBC covers hb and platelets at once.
const ORDER_CODES = ['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV'];
// migration 482's cath_lab_readiness_checks status CHECK.
const CHECK_STATUSES = ['pending', 'pass', 'fail', 'waived', 'not_applicable'];
// The outside-value vocabulary recordExternalLabResult accepts for the three
// qualitative (serology) items.
const QUALITATIVE_VALUES = [
  'reactive', 'non-reactive', 'nonreactive', 'non reactive',
  'positive', 'negative', 'indeterminate', 'not detected', 'detected'
];

// Spec §11: every machine-readable code this surface can answer with. They
// reach the client at the ENVELOPE ROOT, not under `details` — relayAppError
// lifts an AppError's code through responseHelper's topLevel mechanism, and
// cathLabRoutes' own :item guard answers in the same shape so a client reads
// one envelope whichever layer refused.
const ERROR_CODES = [
  'CATH_LAB_READINESS_ITEM_UNKNOWN',
  'CATH_LAB_READINESS_VALUE_INVALID',
  'CATH_LAB_READINESS_ORDER_FAILED',
  'CATH_LAB_READINESS_CASE_STARTED',
  'CATH_LAB_READINESS_ITEMS_EMPTY',
  'CATH_LAB_READINESS_NOT_WAIVED'
];

/** Exported for the source-pin test, which compares them against the service. */
export const ENUMS = Object.freeze({
  ITEMS: Object.freeze([...ITEMS]),
  STATES: Object.freeze([...STATES]),
  SOURCES: Object.freeze([...SOURCES]),
  ORDER_CODES: Object.freeze([...ORDER_CODES]),
  CHECK_STATUSES: Object.freeze([...CHECK_STATUSES]),
  QUALITATIVE_VALUES: Object.freeze([...QUALITATIVE_VALUES]),
  ERROR_CODES: Object.freeze([...ERROR_CODES])
});

/** One `additionalResponses` entry naming the codes that status can carry. */
const errorResponse = (description, codes) => ({
  description: `${description} \`code\`: ${codes.join(', ')}.`,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/CathLabReadinessErrorResponse' }
    }
  }
});

const nullableString = { type: 'string', nullable: true };
const nullableNumber = { type: 'number', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
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

const item = {
  type: 'object',
  additionalProperties: false,
  description:
    'One pre-procedure lab item as the checklist resolved it. A waiver decides the STATE only: '
    + 'the value that prompted it stays on the item, so a waived potassium of 6.9 still raises '
    + 'the critical warning.',
  required: [
    'item_code', 'required', 'state', 'value_text', 'value_numeric', 'unit', 'abnormal_flag',
    'is_critical', 'observed_at', 'source', 'lab_result_id', 'investigation_id', 'specimen_id',
    'ordered_at', 'waived_by', 'waived_at', 'waive_reason'
  ],
  properties: {
    item_code: { type: 'string', enum: ITEMS },
    required: {
      type: 'boolean',
      description: 'Whether the tenant policy requires this item; only required items gate the check.'
    },
    state: {
      type: 'string',
      enum: STATES,
      description:
        '`external_recorded` is an outside laboratory value keyed in through this API. It is '
        + 'UNVERIFIED — never signed off here, never attributed to this laboratory — and counts '
        + 'towards readiness only while the tenant policy says so '
        + '(settings.external_results_count).'
    },
    value_text: nullableString,
    value_numeric: nullableNumber,
    unit: nullableString,
    abnormal_flag: nullableString,
    is_critical: {
      type: 'boolean',
      description:
        'True when the value came back at a critical threshold. On the three serology items '
        + '(hiv, hbsag, hcv) criticality IS the result — only a reactive marker is critical — '
        + 'so it is withheld for roles outside the serology audience, which read false here '
        + 'alongside the nulled value keys.'
    },
    observed_at: nullableDateTime,
    source: { type: 'string', enum: SOURCES, nullable: true },
    lab_result_id: nullableInteger,
    // An open order still in flight is reported alongside a fresh result, so a
    // repeat draw is never ordered twice.
    investigation_id: nullableInteger,
    specimen_id: nullableInteger,
    ordered_at: nullableDateTime,
    waived_by: nullableUuid,
    waived_at: nullableDateTime,
    waive_reason: nullableString
  }
};

const readiness = {
  type: 'object',
  additionalProperties: false,
  description:
    'The pre-procedure lab picture for one cath case, as it stands AFTER the refresh that '
    + 'produced it. `check_status` is the labs readiness check; automation may only move it '
    + 'between pending and pass, and only while it owns the row (`auto_managed`).',
  required: [
    'case_id', 'check_status', 'auto_managed', 'critical_warning', 'critical_items',
    'items', 'missing', 'orderable_now', 'open_order_codes', 'settings', 'case_started'
  ],
  properties: {
    case_id: { type: 'integer', minimum: 1 },
    check_status: { type: 'string', enum: CHECK_STATUSES },
    auto_managed: { type: 'boolean' },
    critical_warning: {
      type: 'boolean',
      description:
        'ADVISORY ONLY: true when any item (required or not, waived or not) came back critical. '
        + 'It never blocks the pass — `missing` is the gate — so a case can be check_status '
        + 'pass with critical_warning true, which is precisely the case the operator at the '
        + 'table has to be told about.'
    },
    // Read across ALL items — required or not, waived or not.
    critical_items: {
      type: 'array',
      description:
        'Which items came back critical. Naming a serology item here says it is reactive, so '
        + 'hiv, hbsag and hcv are withheld for roles outside the serology audience; '
        + 'critical_warning still reports that SOME critical value exists.',
      items: { type: 'string', enum: ITEMS }
    },
    items: { type: 'array', items: { $ref: '#/components/schemas/CathLabReadinessItem' } },
    missing: {
      type: 'array',
      description: 'Required items with no usable value; non-empty is what keeps the check off pass.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'state'],
        properties: {
          item: { type: 'string', enum: ITEMS },
          state: { type: 'string', enum: STATES }
        }
      }
    },
    orderable_now: {
      type: 'array',
      description: 'Catalogue codes that would cover the required items currently not ordered or stale.',
      items: { type: 'string', enum: ORDER_CODES }
    },
    open_order_codes: {
      type: 'array',
      description: 'Every open investigation code on the patient — not only the seven items\' codes.',
      items: { type: 'string' }
    },
    settings: {
      type: 'object',
      additionalProperties: false,
      description:
        'The policy this refresh was judged under. serology_validity_days comes from the device'
        + '-reuse programme\'s own settings, not from this feature.',
      required: [
        'lab_validity_days', 'serology_validity_days', 'auto_pass',
        'external_results_count', 'required_items'
      ],
      properties: {
        lab_validity_days: { type: 'integer', minimum: 1, maximum: 365 },
        serology_validity_days: { type: 'integer', minimum: 1 },
        auto_pass: { type: 'boolean' },
        external_results_count: {
          type: 'boolean',
          description:
            'Whether an `external_recorded` item counts as available. These values are '
            + 'unverified outside results, so a tenant that turns this off keeps them visible '
            + 'on the checklist while refusing to let them clear the check.'
        },
        required_items: { type: 'array', items: { type: 'string', enum: ITEMS } }
      }
    },
    case_started: {
      type: 'boolean',
      description:
        'True once the procedure has an actual start; every write action on this surface is '
        + 'refused after it.'
    }
  }
};

export const schemas = {
  CathLabReadinessErrorResponse: {
    type: 'object',
    additionalProperties: true,
    description:
      'The failure envelope for this surface. `code` sits at the ROOT beside `success` and '
      + '`message`, never under `details`; `details` carries whatever the service attached '
      + '(CATH_LAB_READINESS_ORDER_FAILED, for instance, reports the orders it DID place, so a '
      + 'retry does not double them).',
    required: ['success'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string', enum: ERROR_CODES },
      details: { type: 'object', additionalProperties: true },
      requestId: { type: 'string', nullable: true }
    }
  },

  CathLabReadinessItem: item,
  CathLabReadiness: readiness,
  CathLabReadinessResponse: envelope('CathLabReadiness'),

  CathLabReadinessOrderMissingData: {
    type: 'object',
    additionalProperties: false,
    required: ['created', 'skipped', 'readiness'],
    properties: {
      created: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'investigation_id'],
          properties: {
            code: { type: 'string', enum: ORDER_CODES },
            investigation_id: { type: 'integer', minimum: 1 }
          }
        }
      },
      skipped: {
        type: 'array',
        description: 'Codes deliberately not ordered — today only because an open order already covers them.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'reason'],
          properties: {
            code: { type: 'string', enum: ORDER_CODES },
            reason: { type: 'string' }
          }
        }
      },
      readiness: { $ref: '#/components/schemas/CathLabReadiness' }
    }
  },
  CathLabReadinessOrderMissingResponse: envelope('CathLabReadinessOrderMissingData'),

  CathLabReadinessExternalResultRequest: {
    type: 'object',
    additionalProperties: false,
    description:
      'An outside laboratory\'s value. A value is always required, but WHICH field carries it '
      + 'depends on the item: the three serology items take one of the qualitative tokens in '
      + 'value_text; a quantitative item takes value_numeric (value_text is parsed as a fallback) '
      + 'and needs a unit unless the item\'s default applies.',
    required: ['observed_on', 'external_lab_name'],
    // A value is genuinely required, but which FIELD carries it depends on the
    // item, so `required` alone could never say so: without this a body with an
    // observed_on and a lab name and no value at all was contract-valid, and
    // only the service's 400 caught it.
    anyOf: [
      { required: ['value_text'] },
      { required: ['value_numeric'] }
    ],
    properties: {
      value_text: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description: `Serology items accept exactly one of: ${QUALITATIVE_VALUES.join(', ')}.`
      },
      value_numeric: { type: 'number', minimum: 0 },
      unit: { type: 'string', maxLength: 40 },
      observed_on: {
        type: 'string',
        format: 'date',
        description: 'The day the outside laboratory reported the value. Never in the future (ward day, Asia/Kolkata).'
      },
      external_lab_name: { type: 'string', minLength: 1, maxLength: 160 },
      external_report_ref: { type: 'string', maxLength: 120 },
      notes: { type: 'string', maxLength: 2000 }
    }
  },
  CathLabReadinessExternalResultData: {
    type: 'object',
    additionalProperties: false,
    required: ['lab_result_id', 'item', 'readiness'],
    properties: {
      lab_result_id: { type: 'integer', minimum: 1 },
      item: { type: 'string', enum: ITEMS },
      readiness: { $ref: '#/components/schemas/CathLabReadiness' }
    }
  },
  CathLabReadinessExternalResultResponse: envelope('CathLabReadinessExternalResultData'),

  CathLabReadinessWaiveRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
  },

  CathLabReadinessUnwaiveRequest: {
    type: 'object',
    additionalProperties: false,
    description:
      'Lifting a waiver. `reason` is OPTIONAL and says why the waiver is being withdrawn — '
      + 'unlike the waiver itself, which must state why a gate was cleared. Withdrawing one '
      + 'restores the gate, which is the restrictive direction, so it is not held up for prose; '
      + 'the waiver\'s OWN reason is carried onto the audit row either way.',
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
  },

  CathLabReadinessSettings: {
    type: 'object',
    additionalProperties: false,
    description:
      'Tenant policy for the pre-cath lab checklist. `configured` false means no row has ever '
      + 'been saved and these are the compiled-in defaults — in that shape updated_by, created_at '
      + 'and updated_at are absent rather than null.',
    required: [
      'tenant_id', 'required_items', 'lab_validity_days',
      'auto_pass', 'external_results_count', 'configured'
    ],
    properties: {
      tenant_id: { type: 'string', format: 'uuid' },
      required_items: { type: 'array', minItems: 1, items: { type: 'string', enum: ITEMS } },
      lab_validity_days: { type: 'integer', minimum: 1, maximum: 365 },
      auto_pass: { type: 'boolean' },
      external_results_count: { type: 'boolean' },
      updated_by: nullableUuid,
      created_at: nullableDateTime,
      updated_at: nullableDateTime,
      configured: { type: 'boolean' }
    }
  },
  CathLabReadinessSettingsData: {
    type: 'object',
    additionalProperties: false,
    required: ['settings'],
    properties: { settings: { $ref: '#/components/schemas/CathLabReadinessSettings' } }
  },
  CathLabReadinessSettingsResponse: envelope('CathLabReadinessSettingsData'),
  CathLabReadinessSettingsUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    description:
      'A full REPLACEMENT of the policy, not a patch: an omitted field is written back at its '
      + 'default (all seven items required, 30 days, auto-pass on, outside results count). '
      + 'An explicitly empty required_items is refused — mark the labs check not required on the '
      + 'case instead.',
    properties: {
      required_items: { type: 'array', minItems: 1, items: { type: 'string', enum: ITEMS } },
      lab_validity_days: { type: 'integer', minimum: 1, maximum: 365 },
      auto_pass: { type: 'boolean' },
      external_results_count: { type: 'boolean' }
    }
  }
};

export const operations = {
  'GET /api/v1/cath-lab/cases/{id}/readiness/labs': {
    summary: 'Pre-procedure lab readiness for a cath case',
    description:
      'Resolves and persists the seven pre-procedure lab items from the patient\'s own lab rows '
      + 'and applies the labs-check automation. READ-THROUGH: the answer is the state after that '
      + 'refresh, not a cached snapshot. Carries per-item lab VALUES, so it is PHI: cath report '
      + 'read plus the per-case patient guard, and the mount logs the access against the case '
      + 'patient.',
    pathParameters: { id: BIGINT_WIRE },
    response: 'CathLabReadinessResponse',
    additionalResponses: {
      400: errorResponse(
        'A stored item is not resolvable — a row in state waived that has lost its who/when/why.',
        ['CATH_LAB_READINESS_VALUE_INVALID']
      )
    }
  },
  'POST /api/v1/cath-lab/cases/{id}/readiness/evidence/refresh': {
    summary: 'Re-evidence every readiness check on a cath case',
    description:
      'Re-runs the eight readiness checks against their live evidence and, ADDITIVELY, the '
      + 'pre-procedure lab refresh. The lab half is never a precondition of the other seven: a '
      + 'lab failure is logged and answered as `labs: null` rather than losing the work already '
      + 'done. `data` is the evidence-refresh result plus a `labs` key carrying '
      + 'CathLabReadiness or null — typed here only in prose because this operation predates '
      + 'the readiness overlay and still answers the generic Success envelope.',
    pathParameters: { id: BIGINT_WIRE }
  },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/order-missing': {
    summary: 'Order every missing pre-cath lab',
    description:
      'Places the covering catalogue orders for every required item that is not ordered or has '
      + 'gone stale (CBC covers Hb and platelets at once). Codes that already have an open order '
      + 'are reported in `skipped` rather than ordered again. Refused once the procedure has '
      + 'started. Requires Idempotency-Key (scope cath_lab_readiness_order).',
    pathParameters: { id: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    responseStatus: 201,
    response: 'CathLabReadinessOrderMissingResponse',
    additionalResponses: {
      400: errorResponse(
        'A stored item is not resolvable.',
        ['CATH_LAB_READINESS_VALUE_INVALID']
      ),
      409: errorResponse(
        'The procedure has already started; order from the case instead.',
        ['CATH_LAB_READINESS_CASE_STARTED']
      ),
      500: errorResponse(
        'An order could not be placed. `details.created` names the orders that DID land, so a '
        + 'retry does not double them.',
        ['CATH_LAB_READINESS_ORDER_FAILED']
      )
    }
  },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/{item}/external-result': {
    summary: 'Record an outside laboratory result for one item',
    description:
      'Records an outside-laboratory value as an external-origin lab result — never signed off, '
      + 'never attributed to this laboratory — and refreshes readiness. This is the ONLY route '
      + 'that may create such a row. Serology also lands on the patient\'s blood-borne marker '
      + 'record. Refused once the procedure has started. Requires Idempotency-Key (scope '
      + 'cath_lab_readiness_external); the claimed key and body hash are what make a retry re-read '
      + 'the same command instead of recording the value twice.',
    pathParameters: { id: BIGINT_WIRE, item: { type: 'string', enum: ITEMS } },
    parameters: [idempotencyHeaderParameter],
    request: 'CathLabReadinessExternalResultRequest',
    responseStatus: 201,
    response: 'CathLabReadinessExternalResultResponse',
    additionalResponses: {
      400: errorResponse(
        'The item code is not one of the seven (refused at the route, before the '
        + 'Idempotency-Key is claimed), or the value, unit, lab name or observed_on is not '
        + 'usable for that item.',
        ['CATH_LAB_READINESS_ITEM_UNKNOWN', 'CATH_LAB_READINESS_VALUE_INVALID']
      ),
      409: errorResponse(
        'The procedure has already started; record the value against the case instead.',
        ['CATH_LAB_READINESS_CASE_STARTED']
      )
    }
  },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/{item}/waive': {
    summary: 'Waive one pre-cath lab item',
    description:
      'Records a clinical decision to proceed without one item, with who/when/why. The waiver '
      + 'decides the state only — any value already on the item stays, so a waived critical result '
      + 'still raises the warning. Refused once the procedure has started: the pre-procedure '
      + 'record says what the team knew BEFORE the case and is not editable after it. Requires '
      + 'Idempotency-Key (scope cath_lab_readiness_waive).',
    pathParameters: { id: BIGINT_WIRE, item: { type: 'string', enum: ITEMS } },
    parameters: [idempotencyHeaderParameter],
    request: 'CathLabReadinessWaiveRequest',
    response: 'CathLabReadinessResponse',
    additionalResponses: {
      400: errorResponse(
        'The item code is not one of the seven (refused at the route, before the '
        + 'Idempotency-Key is claimed), or no reason was given.',
        ['CATH_LAB_READINESS_ITEM_UNKNOWN', 'CATH_LAB_READINESS_VALUE_INVALID']
      ),
      409: errorResponse(
        'The procedure has already started; the pre-procedure record is closed.',
        ['CATH_LAB_READINESS_CASE_STARTED']
      )
    }
  },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/{item}/unwaive': {
    summary: 'Remove the waiver on one pre-cath lab item',
    description:
      'Withdraws a waiver, so the item is resolved from the patient\'s lab evidence again — '
      + 'which may leave it missing and take the labs check back off pass. It is a SECOND '
      + 'decision recorded over the first, not an undo: the waiver and its audit row stand, and '
      + 'this writes its own row carrying the withdrawn waiver\'s reason. Refused once the '
      + 'procedure has started, and refused when the item is not waived. Requires '
      + 'Idempotency-Key (scope cath_lab_readiness_unwaive).',
    pathParameters: { id: BIGINT_WIRE, item: { type: 'string', enum: ITEMS } },
    parameters: [idempotencyHeaderParameter],
    request: 'CathLabReadinessUnwaiveRequest',
    response: 'CathLabReadinessResponse',
    additionalResponses: {
      400: errorResponse(
        'The item code is not one of the seven (refused at the route, before the '
        + 'Idempotency-Key is claimed).',
        ['CATH_LAB_READINESS_ITEM_UNKNOWN']
      ),
      409: errorResponse(
        'The procedure has already started, or the item carries no waiver to remove — decided '
        + 'from the stored row under the case lock, so a second tap is told so rather than '
        + 'writing an audit row about a waiver that was already gone.',
        ['CATH_LAB_READINESS_CASE_STARTED', 'CATH_LAB_READINESS_NOT_WAIVED']
      )
    }
  },

  'GET /api/v1/cath-reprocessing/lab-readiness-settings': {
    summary: 'Read the tenant pre-cath lab policy',
    description:
      'Tenant-wide clinical governance, no patient identity. It sits on the cath-reprocessing '
      + 'governance mount — the same audience (QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN, '
      + 'SUPER_ADMIN) that owns the device-reuse policy — and not on the platform-admin console.',
    response: 'CathLabReadinessSettingsResponse'
  },
  'PUT /api/v1/cath-reprocessing/lab-readiness-settings': {
    summary: 'Replace the tenant pre-cath lab policy',
    description:
      'Replaces the policy wholesale; an omitted field is written back at its default. Requires '
      + 'Idempotency-Key (scope cath_reprocessing_policy — shared with the reprocessing '
      + 'settings/policies writes, which are edited from the same screen).',
    parameters: [idempotencyHeaderParameter],
    request: 'CathLabReadinessSettingsUpdateRequest',
    response: 'CathLabReadinessSettingsResponse',
    additionalResponses: {
      400: errorResponse(
        'required_items was explicitly empty, or named a code outside the seven.',
        ['CATH_LAB_READINESS_ITEMS_EMPTY', 'CATH_LAB_READINESS_ITEM_UNKNOWN']
      )
    }
  }
};
