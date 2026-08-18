// OpenAPI overlay — Pharmacy catalog composition surface (Phase 2, final slice).
// Types the two composition-aware catalog reads:
//   GET  /pharmacy-orders/catalog                       (list; +8 composition fields)
//   GET  /pharmacy-orders/catalog/{id}/alternatives     (same-composition siblings)
// Authored from the EXACT controller returns in
// controllers/pharmacy/pharmacyOrderController.js (getCatalog / getCatalogAlternatives).
//
// Alias note: routes/pharmacy/index.js is mounted TWICE in app.js — at
// /api/v1/pharmacy-orders AND /api/v1/pharmacy (the admin dashboard alias). Both
// path keys survive the buildSpec collapse (the literal segment differs:
// `pharmacy-orders` vs `pharmacy`), exactly like the emr/admissions alias. We
// therefore key each overlay under BOTH prefixes via aliasOps() so neither alias
// falls back to the generic Success envelope.
//
// Gotchas honoured: no `null` inside any enum (Spectral 6.16 crashes on it —
// nullable string fields use {type:'string',nullable:true}); every schema name is
// pharmacy-prefixed so it can't collide with another module (the generator's
// duplicate-schema-name guard). Decimal columns (unit_price/price) serialize as
// STRINGS (Prisma.Decimal.toJSON → string), matching the money overlay.
import { envelope } from './_helpers.mjs';

// availability_status is a closed 3-value set (getCatalogAlternatives derives it;
// never null). Null-free — safe to enum-bind directly.
const AVAILABILITY_STATUS = ['in_stock', 'may_be_available', 'out_of_stock'];

export const schemas = {
  // =========================================================================
  // GET /catalog — list item
  // =========================================================================
  // Raw pharmacy_catalog SELECT row (+ dc.display_label AS composition_label from
  // the LEFT JOIN). LOOSE (additionalProperties:true) with a small required core;
  // the raw row is stable but future columns should not break the contract.
  // Decimal price/unit_price → strings|null; Int stock/reorder_level/composition_id
  // → integer|null; composition_* strings → nullable.
  PharmacyCatalogItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      generic_name: { type: 'string', nullable: true },
      category: { type: 'string', nullable: true },
      manufacturer: { type: 'string', nullable: true },
      // Decimal(12,2) → serialized as a string via Prisma.Decimal.toJSON.
      price: { type: 'string', nullable: true },
      unit_price: { type: 'string', nullable: true },
      pack_size: { type: 'string', nullable: true },
      // COALESCE(stock_quantity, stock) — both Int?; may be null if both null.
      stock: { type: 'integer', nullable: true },
      in_stock: { type: 'boolean', nullable: true },
      is_available: { type: 'boolean', nullable: true },
      requires_prescription: { type: 'boolean', nullable: true },
      reorder_level: { type: 'integer', nullable: true },
      description: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      // ---- composition fields (Phase 2, additive) ----
      composition_id: { type: 'integer', nullable: true },
      composition_label: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      strength_key: { type: 'string', nullable: true },
      form: { type: 'string', nullable: true },
      form_key: { type: 'string', nullable: true },
      release_key: { type: 'string', nullable: true },
      composition_confidence: { type: 'string', nullable: true },
    },
  },

  // GET /catalog → success(res, result, 'Catalog') — bare PharmacyCatalogItem[].
  PharmacyCatalogListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { type: 'array', items: { $ref: '#/components/schemas/PharmacyCatalogItem' } },
      meta: { type: 'object', additionalProperties: true },
    },
  },

  // =========================================================================
  // GET /catalog/{id}/alternatives — { selected, groups, alternatives }
  // =========================================================================
  // Per-alternative item (alternatives[] element, also groups[].items[]). STRICT —
  // the controller builds this object literally with a fixed key set. route is a
  // free string|null (no enum). stock_quantity is Number()|null → integer|null.
  PharmacyAlternativeItem: {
    type: 'object',
    additionalProperties: false,
    required: ['catalog_id', 'availability_status', 'substitutable'],
    properties: {
      catalog_id: { type: 'integer' },
      name: { type: 'string', nullable: true },
      manufacturer: { type: 'string', nullable: true },
      generic_name: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      strength_key: { type: 'string', nullable: true },
      form: { type: 'string', nullable: true },
      form_key: { type: 'string', nullable: true },
      release_key: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      stock_quantity: { type: 'integer', nullable: true },
      availability_status: { type: 'string', enum: AVAILABILITY_STATUS },
      substitutable: { type: 'boolean' },
    },
  },

  // groups[] element — { strength_key, form_key, strength, form, matched, items }.
  // STRICT. strength_key/form_key/strength/form mirror the item nullable strings.
  PharmacyAlternativesGroup: {
    type: 'object',
    additionalProperties: false,
    required: ['matched', 'items'],
    properties: {
      strength_key: { type: 'string', nullable: true },
      form_key: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      form: { type: 'string', nullable: true },
      matched: { type: 'boolean' },
      items: { type: 'array', items: { $ref: '#/components/schemas/PharmacyAlternativeItem' } },
    },
  },

  // selected (publicSelected) — resolved identity of the queried catalog id, or
  // null when the feature flag is OFF / brand unresolved. STRICT.
  PharmacyAlternativesSelected: {
    type: 'object',
    additionalProperties: false,
    required: ['catalog_id'],
    properties: {
      catalog_id: { type: 'integer' },
      composition_id: { type: 'integer', nullable: true },
      composition_label: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      strength_key: { type: 'string', nullable: true },
      form: { type: 'string', nullable: true },
      form_key: { type: 'string', nullable: true },
      release_key: { type: 'string', nullable: true },
    },
  },

  // data payload — { selected: PharmacyAlternativesSelected|null, groups[], alternatives[] }.
  PharmacyAlternativesData: {
    type: 'object',
    additionalProperties: false,
    required: ['selected', 'groups', 'alternatives'],
    properties: {
      // nullable $ref → wrap in allOf so nullable applies (OAS 3.0 sibling-keyword rule).
      selected: { nullable: true, allOf: [{ $ref: '#/components/schemas/PharmacyAlternativesSelected' }] },
      groups: { type: 'array', items: { $ref: '#/components/schemas/PharmacyAlternativesGroup' } },
      alternatives: { type: 'array', items: { $ref: '#/components/schemas/PharmacyAlternativeItem' } },
    },
  },

  // GET /catalog/{id}/alternatives → success(res, {selected,groups,alternatives}, …).
  PharmacyAlternativesResponse: envelope('PharmacyAlternativesData'),

  // =========================================================================
  // POST /dispense-substitution (+ its Schedule X / narcotic witness flow)
  // =========================================================================
  // The substitution intent — exactly the client-known fields the witness
  // fingerprint binds to (witness_approval_id / credentials excluded).
  PharmacyDispenseSubstitutionIntent: {
    type: 'object',
    required: [
      'patient_uid', 'inventory_item_id', 'inventory_batch_id',
      'quantity', 'original_catalog_id', 'final_catalog_id',
    ],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', nullable: true },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0.0001 },
      original_catalog_id: { type: 'integer', minimum: 1 },
      final_catalog_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', nullable: true, maxLength: 500 },
    },
  },

  PharmacyDispenseSubstitutionRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'patient_uid', 'inventory_item_id', 'inventory_batch_id',
      'quantity', 'original_catalog_id', 'final_catalog_id',
    ],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', nullable: true },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0.0001 },
      original_catalog_id: { type: 'integer', minimum: 1 },
      final_catalog_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', nullable: true, maxLength: 500 },
      witness_approval_id: {
        type: 'string',
        pattern: '^[1-9][0-9]*$',
        nullable: true,
        description:
          'Approved, unexpired one-time witness approval from the two-person substitution witness flow. Required when the dispensed inventory item is Schedule X / narcotic; caller-selected witness identity is never accepted.',
      },
      performed_by_name: {
        type: 'string', nullable: true, maxLength: 255,
        description:
          'Display name recorded on the statutory register for controlled substitutes; defaults to the authenticated dispenser’s roster name.',
      },
    },
  },

  PharmacyDispenseSubstitutionResult: {
    type: 'object',
    required: ['movement_id', 'original_catalog_id', 'final_catalog_id', 'quantity'],
    properties: {
      movement_id: { type: 'integer' },
      original_catalog_id: { type: 'integer' },
      final_catalog_id: { type: 'integer' },
      quantity: { type: 'number' },
      // Present only for controlled (Schedule H/H1/X / narcotic) substitutes,
      // which route through the statutory pharmacy_schedule_register.
      schedule_class: { type: 'string', nullable: true },
      is_narcotic: { type: 'boolean' },
      register_entry_id: { type: 'integer', nullable: true },
    },
  },
  PharmacyDispenseSubstitutionResponse: envelope('PharmacyDispenseSubstitutionResult'),

  PharmacySubstitutionWitnessApprovalRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'patient_uid', 'inventory_item_id', 'inventory_batch_id',
      'quantity', 'original_catalog_id', 'final_catalog_id',
    ],
    description:
      'The exact prospective substitution payload to bind to a short-lived pending witness approval. witness_approval_id is not accepted on this pre-approval request.',
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', nullable: true },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0.0001 },
      original_catalog_id: { type: 'integer', minimum: 1 },
      final_catalog_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', nullable: true, maxLength: 500 },
    },
  },

  PharmacySubstitutionWitnessApprovalDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['substitution'],
    properties: {
      substitution: {
        $ref: '#/components/schemas/PharmacySubstitutionWitnessApprovalRequest',
      },
      employeeId: {
        type: 'string',
        pattern: '^[A-Z0-9-]{3,20}$',
        description:
          'Witness employee ID for an in-session password step-up. Must be supplied with password; the server derives the witness UID from this authentication.',
      },
      password: {
        type: 'string',
        format: 'password',
        minLength: 6,
        maxLength: 100,
        writeOnly: true,
        description:
          'Witness password for the one-request step-up. It is neither returned nor persisted (and never enters the idempotency hash) and does not replace the dispenser session.',
      },
    },
    oneOf: [
      { required: ['employeeId', 'password'] },
      {
        not: {
          anyOf: [
            { required: ['employeeId'] },
            { required: ['password'] },
          ],
        },
      },
    ],
  },

  // Approval rows share the counter-sale/inventory witness approval shape.
  PharmacySubstitutionWitnessApprovalResponse: envelope('PharmacyCounterSaleWitnessApproval'),
};

// ---------------------------------------------------------------------------
// Operations — keyed under BOTH mount prefixes (the router is mounted twice).
// Each entry is a [«METHOD /suffix», overlay] pair; aliasOps() fans it out to
// /api/v1/pharmacy-orders AND /api/v1/pharmacy so neither alias falls back to
// the generic Success envelope.
// ---------------------------------------------------------------------------
const substitutionWitnessErrorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PharmacyControlledDispenseWitnessErrorResponse' },
    },
  },
});

const substitutionWitnessErrorResponses = ({ idempotent = false } = {}) => ({
  400: substitutionWitnessErrorResponse('The substitution payload, witness identity, or credential pair was invalid — including a Schedule X / narcotic substitute submitted without witness_approval_id (SUBSTITUTION_WITNESS_REQUIRED).'),
  401: substitutionWitnessErrorResponse('The independently supplied witness credentials were invalid.'),
  403: substitutionWitnessErrorResponse('The authenticated caller or witness tenant/role was not permitted.'),
  404: substitutionWitnessErrorResponse('The inventory item, batch, patient, or witness approval was not found in this tenant.'),
  409: substitutionWitnessErrorResponse('The approval expired, was consumed, or did not match the unchanged substitution.'),
  429: substitutionWitnessErrorResponse('The witness credential attempt was rate limited or locked.'),
  500: substitutionWitnessErrorResponse('The substitution witness approval could not be completed.'),
  ...(idempotent ? {
    422: substitutionWitnessErrorResponse('The Idempotency-Key was reused with a different request body.'),
    503: substitutionWitnessErrorResponse('The idempotency store was unavailable, so the mutation failed closed.'),
  } : {}),
});

const substitutionBearerSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];
const substitutionIdempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Stable key for this logical mutation. Retries with the unchanged body replay the durable original result.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$',
  },
};
const substitutionApprovalIdPathSchema = { type: 'string', pattern: '^[1-9][0-9]*$' };

const OPS = [
  ['GET /catalog', { response: 'PharmacyCatalogListResponse' }],
  ['GET /catalog/{id}/alternatives', { response: 'PharmacyAlternativesResponse' }],
  ['POST /dispense-substitution', {
    description:
      'Pharmacist dispenses an in-stock, same-formulation alternative for a prescribed brand. Both catalog ids are server-resolved and the swap re-checked for equivalence; the chosen batch is locked, validated and decremented atomically with the canonical clinical timeline + audit pair. Controlled substitutes (Schedule H/H1/X or narcotic inventory items) route through the witnessed statutory-register controlled-dispense path in the same transaction; Schedule X / narcotic substitutes additionally require an approved one-time witness_approval_id and fail closed without it.',
    request: 'PharmacyDispenseSubstitutionRequest',
    response: 'PharmacyDispenseSubstitutionResponse',
    security: substitutionBearerSecurity,
    additionalResponses: substitutionWitnessErrorResponses(),
  }],
  ['POST /dispense-substitution/witness-approvals', {
    description:
      'Dispensing pharmacist creates a short-lived pending witness approval bound to the authenticated dispenser and the exact prospective Schedule X / narcotic substitution payload.',
    request: 'PharmacySubstitutionWitnessApprovalRequest',
    response: 'PharmacySubstitutionWitnessApprovalResponse',
    security: substitutionBearerSecurity,
    parameters: [substitutionIdempotencyKeyParameter],
    additionalResponses: substitutionWitnessErrorResponses({ idempotent: true }),
  }],
  ['POST /dispense-substitution/witness-approvals/{id}/approve', {
    description:
      'A separately authenticated eligible pharmacy, medical, or nursing witness approves the unchanged substitution payload. The dispenser may then submit the returned one-time approval id; self-witness, administrative witnesses, tenant mismatch, expiry, replay, and payload changes fail closed.',
    request: 'PharmacySubstitutionWitnessApprovalDecisionRequest',
    response: 'PharmacySubstitutionWitnessApprovalResponse',
    security: substitutionBearerSecurity,
    pathParameters: { id: substitutionApprovalIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    additionalResponses: substitutionWitnessErrorResponses({ idempotent: true }),
  }],
];

const PREFIXES = ['/api/v1/pharmacy-orders', '/api/v1/pharmacy'];

/** Fan each [«METHOD /suffix», overlay] out to the given mount prefixes. */
function aliasOps(pairs, prefixes = PREFIXES) {
  const out = {};
  for (const [methodSuffix, ov] of pairs) {
    const spaceIdx = methodSuffix.indexOf(' ');
    const method = methodSuffix.slice(0, spaceIdx);
    const suffix = methodSuffix.slice(spaceIdx + 1);
    for (const pre of prefixes) out[`${method} ${pre}${suffix}`] = ov;
  }
  return out;
}

export const operations = aliasOps(OPS);
