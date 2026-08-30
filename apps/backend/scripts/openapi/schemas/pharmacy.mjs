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
const PHARMACY_PAYMENT_MODES = [
  'cash', 'card', 'upi', 'wallet', 'corporate_tpa', 'insurance', 'none',
];
const positiveInt32 = { type: 'integer', minimum: 1, maximum: 2147483647 };
const nonNegativeMoney = {
  oneOf: [
    { type: 'number', minimum: 0 },
    { type: 'string', pattern: '^\\d+(?:\\.\\d+)?$' },
  ],
};
const positiveSignedInt64String = {
  type: 'string',
  pattern: '^[1-9][0-9]{0,18}$',
  minLength: 1,
  maxLength: 19,
  'x-maximum': '9223372036854775807',
};
const pharmacyFacilityBoundApprovalIdPathSchema = {
  ...positiveSignedInt64String,
  description: 'Canonical witness approval id serialized as text.',
};
const facilityBoundWitnessApprovalSchema = ({ scope, payloadSchema }) => {
  const publicProperties = {
    id: pharmacyFacilityBoundApprovalIdPathSchema,
    contract: { type: 'string', enum: ['controlled_dispense_witness_v1'] },
    scope: { type: 'string', enum: [scope] },
    requested_by: { type: 'string', format: 'uuid' },
    payload: payloadSchema,
    payload_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    expires_at: { type: 'string', format: 'date-time' },
  };
  const required = [
    'id',
    'contract',
    'scope',
    'status',
    'requested_by',
    'payload',
    'payload_fingerprint',
    'expires_at',
  ];
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required,
        properties: {
          ...publicProperties,
          status: { type: 'string', enum: ['pending'] },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [...required, 'witness'],
        properties: {
          ...publicProperties,
          status: { type: 'string', enum: ['approved'] },
          witness: {
            $ref: '#/components/schemas/PharmacyFacilityBoundControlledWitnessIdentity',
          },
        },
      },
    ],
  };
};

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

  PharmacyOrderLine: {
    type: 'object',
    additionalProperties: true,
    required: ['order_line_index', 'catalog_id'],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0, nullable: true },
      catalog_id: positiveInt32,
      inventory_item_id: { ...positiveInt32, nullable: true },
      name: { type: 'string', nullable: true },
      medication_name: { type: 'string', nullable: true },
      generic_name: { type: 'string', nullable: true },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      ordered_qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      prescribed_qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      dispensed_qty: { type: 'number', minimum: 0, nullable: true },
      remaining_qty: { type: 'number', minimum: 0, nullable: true },
      price: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      line_total: { type: 'number', minimum: 0, nullable: true },
    },
  },
  PharmacyPrescriptionMedication: {
    type: 'object',
    additionalProperties: true,
    properties: {
      catalog_id: positiveInt32,
      name: { type: 'string', nullable: true },
      medication_name: { type: 'string', nullable: true },
      drug_name: { type: 'string', nullable: true },
      dose: { type: 'string', nullable: true },
      dosage: { type: 'string', nullable: true },
      frequency: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      duration: { type: 'string', nullable: true },
      instructions: { type: 'string', nullable: true },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
    },
  },
  PharmacyFundingRecoveryTask: {
    type: 'object',
    additionalProperties: false,
    required: [
      'task_id', 'status', 'owner_role', 'pharmacy_order_id', 'invoice_item_id',
      'order_version', 'order_items_sha256', 'deep_link',
    ],
    properties: {
      task_id: {
        oneOf: [positiveInt32, { type: 'string', minLength: 1, maxLength: 160 }],
      },
      status: {
        type: 'string', enum: ['open', 'in_progress', 'blocked', 'overdue'],
      },
      owner_role: {
        type: 'string',
        enum: [
          'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER', 'FINANCE_INCHARGE',
          'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
        ],
      },
      task_type: {
        type: 'string', nullable: true,
        enum: ['tpa_line_decision', 'posted_payment', null],
      },
      pharmacy_order_id: positiveInt32,
      invoice_id: { ...positiveInt32, nullable: true },
      invoice_item_id: positiveInt32,
      tpa_claim_id: { ...positiveInt32, nullable: true },
      order_version: positiveInt32,
      order_items_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      amount_outstanding: { ...nonNegativeMoney, nullable: true },
      deep_link: {
        type: 'string',
        format: 'uri-reference',
        pattern:
          '^/billing-desk\\?pharmacy_order_id=[1-9][0-9]*&invoice_item_id=[1-9][0-9]*(&tpa_claim_id=[1-9][0-9]*)?$',
        description:
          'Role-gated billing recovery target containing the exact positive pharmacy_order_id and invoice_item_id, plus tpa_claim_id for claim-backed authority.',
      },
    },
  },
  PharmacyOrderQueueLine: {
    type: 'object',
    additionalProperties: true,
    required: ['catalog_id'],
    description:
      'A typed queue line. Legacy rows awaiting governed repair may omit one or both stable indexes; line_identity_recovery_required on the containing order identifies that recovery state.',
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0, nullable: true },
      catalog_id: positiveInt32,
      inventory_item_id: { ...positiveInt32, nullable: true },
      name: { type: 'string', nullable: true },
      medication_name: { type: 'string', nullable: true },
      generic_name: { type: 'string', nullable: true },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      ordered_qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      prescribed_qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      dispensed_qty: { type: 'number', minimum: 0, nullable: true },
      remaining_qty: { type: 'number', minimum: 0, nullable: true },
      price: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      line_total: { type: 'number', minimum: 0, nullable: true },
    },
  },
  PharmacyOrderQueueItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'status', 'facility_id', 'order_number', 'items_list',
      'inventory_authority_version', 'total_amount', 'payment_status',
      'payment_mode', 'amount_collected', 'payment_metadata',
      'clinical_verification_status', 'clinically_verified_order_version',
      'prescription_id', 'linked_prescription_count', 'prescription_medications',
      'line_identity_recovery_required',
      'facility_recovery_required', 'facility_recovery_target_id',
      'created_at', 'updated_at',
    ],
    properties: {
      id: positiveInt32,
      uid: { type: 'string', format: 'uuid', nullable: true },
      patient_id: { type: 'integer', minimum: 1, nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      prescription_url: { type: 'string', nullable: true },
      prescription_photo_key: { type: 'string', nullable: true },
      prescription_photo_url: { type: 'string', format: 'uri', nullable: true },
      status: { type: 'string' },
      order_note: { type: 'string', nullable: true },
      delivery_type: { type: 'string', nullable: true },
      delivery_address: { type: 'string', nullable: true },
      total_amount: { ...nonNegativeMoney, nullable: true },
      payment_status: { type: 'string', nullable: true },
      payment_mode: { type: 'string', enum: PHARMACY_PAYMENT_MODES, nullable: true },
      amount_collected: { ...nonNegativeMoney, nullable: true },
      payment_metadata: {
        type: 'object',
        additionalProperties: true,
        nullable: true,
      },
      funding_recovery: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/PharmacyFundingRecoveryTask' }],
      },
      assigned_pharmacist: { type: 'string', format: 'uuid', nullable: true },
      token_number: { type: 'string', nullable: true },
      order_number: { type: 'string', nullable: true },
      items_list: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderQueueLine' },
        nullable: true,
      },
      facility_id: { ...positiveInt32, nullable: true },
      inventory_authority_version: { type: 'integer', minimum: 1 },
      delivery_assignee_uid: { type: 'string', format: 'uuid', nullable: true },
      delivery_handoff_generation: { type: 'integer', minimum: 1, nullable: true },
      delivery_custody_status: {
        type: 'string',
        enum: ['in_transit', 'delivered', 'return_pending', 'returned', 'quarantined'],
        nullable: true,
      },
      delivery_tracking_active: { type: 'boolean', nullable: true },
      clinical_verification_status: {
        type: 'string',
        enum: ['pending', 'verified', 'override', 'rejected'],
        nullable: true,
      },
      clinically_verified_order_version: { type: 'integer', minimum: 1, nullable: true },
      prescription_id: { ...positiveInt32, nullable: true },
      linked_prescription_count: { type: 'integer', minimum: 0 },
      prescription_medications: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyPrescriptionMedication' },
        nullable: true,
      },
      line_identity_recovery_required: { type: 'boolean' },
      facility_recovery_required: { type: 'boolean' },
      facility_recovery_target_id: { ...positiveInt32, nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      dispatched_at: { type: 'string', format: 'date-time', nullable: true },
      delivered_at: { type: 'string', format: 'date-time', nullable: true },
      mins_since_placed: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      sla_breached: { type: 'boolean' },
    },
  },
  PharmacyOrderQueueResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message', 'data'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      message: { type: 'string' },
      data: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderQueueItem' } },
      requestId: { type: 'string', nullable: true },
    },
  },
  PharmacyOrderManualConfirmationLine: {
    type: 'object',
    additionalProperties: false,
    required: ['order_line_index', 'catalog_id', 'quantity'],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      catalog_id: positiveInt32,
      inventory_item_id: positiveInt32,
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
    },
  },
  PharmacyOrderConfirmationRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items_list: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { $ref: '#/components/schemas/PharmacyOrderManualConfirmationLine' },
        description: 'Required for manual/photo orders and forbidden from changing prescription-bound lines.',
      },
      total_amount: { type: 'number', minimum: 0 },
      confirmation_notes: { type: 'string', nullable: true },
    },
  },
  PharmacyOrderDispensableLine: {
    type: 'object',
    additionalProperties: false,
    required: [
      'prescription_id', 'order_line_index', 'prescription_line_index',
      'catalog_id', 'name', 'quantity',
    ],
    properties: {
      prescription_id: { type: 'integer', minimum: 1 },
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      catalog_id: { type: 'integer', minimum: 1 },
      name: { type: 'string', nullable: true },
      quantity: { type: 'number', nullable: true },
    },
  },
  PharmacyOrderDispensableContext: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_id', 'prescription_id', 'patient_uid', 'facility_id',
      'delivery_type', 'total_amount', 'payment_mode', 'payment_status',
      'amount_collected', 'tpa_reference', 'lines',
    ],
    properties: {
      order_id: positiveInt32,
      prescription_id: { ...positiveInt32, nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      appointment_id: { ...positiveInt32, nullable: true },
      admission_id: { ...positiveInt32, nullable: true },
      facility_id: { ...positiveInt32, nullable: true },
      delivery_type: { type: 'string', enum: ['counter', 'delivery'], nullable: true },
      total_amount: { type: 'number', minimum: 0 },
      payment_mode: { type: 'string', enum: PHARMACY_PAYMENT_MODES, nullable: true },
      payment_status: { type: 'string', nullable: true },
      amount_collected: { type: 'number', minimum: 0 },
      tpa_reference: { type: 'string', nullable: true },
      lines: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderDispensableLine' } },
    },
  },
  PharmacyOrderDispensableContextResponse: envelope('PharmacyOrderDispensableContext'),

  PharmacyOrderMutationResult: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: positiveInt32,
      uid: { type: 'string', format: 'uuid', nullable: true },
      facility_id: { ...positiveInt32, nullable: true },
      status: {
        type: 'string',
        enum: [
          'PENDING', 'CONFIRMED', 'PREPARING', 'DISPATCHED',
          'PARTIALLY_DISPENSED', 'DISPENSED', 'DELIVERED',
          'UNAVAILABLE', 'CANCELLED',
        ],
      },
      inventory_authority_version: { type: 'integer', minimum: 1 },
      clinical_verification_status: {
        type: 'string',
        enum: ['pending', 'verified', 'override', 'rejected'],
        nullable: true,
      },
      order_number: { type: 'string', nullable: true },
      items_list: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderLine' },
        nullable: true,
      },
      total_amount: { ...nonNegativeMoney, nullable: true },
      idempotent_replay: { type: 'boolean' },
    },
  },
  PharmacyOrderMutationResponse: envelope('PharmacyOrderMutationResult'),
  PharmacyOrderHistoryItem: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'order_id', 'to_status', 'created_at'],
    properties: {
      id: positiveInt32,
      order_id: positiveInt32,
      from_status: { type: 'string', nullable: true },
      to_status: { type: 'string' },
      changed_by: { type: 'integer', minimum: 1, nullable: true },
      changed_by_role: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  PharmacyOrderDetailData: {
    type: 'object',
    additionalProperties: false,
    required: ['order', 'history'],
    properties: {
      order: { $ref: '#/components/schemas/PharmacyOrderMutationResult' },
      history: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderHistoryItem' },
      },
    },
  },
  PharmacyOrderDetailResponse: envelope('PharmacyOrderDetailData'),
  PharmacyRejectedPrescriptionAmendmentMedication: {
    type: 'object',
    additionalProperties: false,
    required: ['catalog_id', 'ordered_quantity'],
    properties: {
      catalog_id: positiveInt32,
      ordered_quantity: positiveInt32,
      dose: { type: 'string', maxLength: 120, nullable: true },
      frequency: { type: 'string', maxLength: 120, nullable: true },
      route: { type: 'string', maxLength: 80, nullable: true },
      duration: { type: 'string', maxLength: 120, nullable: true },
      instructions: { type: 'string', maxLength: 1000, nullable: true },
    },
  },
  PharmacyRejectedPrescriptionAmendmentRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'expected_prescription_revision',
      'expected_order_version',
      'medications',
      'amendment_reason',
    ],
    properties: {
      expected_prescription_revision: positiveInt32,
      expected_order_version: positiveInt32,
      medications: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { $ref: '#/components/schemas/PharmacyRejectedPrescriptionAmendmentMedication' },
      },
      amendment_reason: { type: 'string', minLength: 10, maxLength: 500 },
      authorization_reason: {
        type: 'string',
        minLength: 10,
        maxLength: 500,
        nullable: true,
        description:
          'Mandatory when an active same-tenant CMO or MEDICAL_SUPERINTENDENT acts instead of the original prescriber.',
      },
    },
  },
  PharmacyRejectedPrescriptionAmendmentResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'prescription_id',
      'pharmacy_order_id',
      'status',
      'clinical_verification_status',
      'amendment_state',
      'prior_prescription_revision',
      'prescription_revision',
      'prior_order_version',
      'order_version',
      'rejected_items_sha256',
      'amended_items_sha256',
      'authorization_basis',
      'covering_authority_id',
      'covering_authority_source',
      'controlled_privilege_id',
      'amended_by',
      'amended_by_role',
      'amended_at',
      'medications',
      'items_list',
      'total_amount',
      'safety',
      'idempotent_replay',
    ],
    properties: {
      prescription_id: positiveInt32,
      pharmacy_order_id: positiveInt32,
      status: { type: 'string', enum: ['ON_HOLD'] },
      clinical_verification_status: { type: 'string', enum: ['rejected'] },
      amendment_state: { type: 'string', enum: ['pending_reverification'] },
      prior_prescription_revision: positiveInt32,
      prescription_revision: positiveInt32,
      prior_order_version: positiveInt32,
      order_version: positiveInt32,
      rejected_items_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      amended_items_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      authorization_basis: {
        type: 'string',
        enum: ['original_prescriber', 'same_tenant_clinical_leader'],
      },
      covering_authority_id: { ...positiveInt32, nullable: true },
      covering_authority_source: {
        type: 'string',
        enum: ['care_team', 'patient_access_break_glass'],
        nullable: true,
      },
      controlled_privilege_id: { ...positiveInt32, nullable: true },
      amended_by: { type: 'string', format: 'uuid' },
      amended_by_role: {
        type: 'string',
        enum: ['DOCTOR', 'DUTY_DOCTOR', 'CMO', 'MEDICAL_SUPERINTENDENT'],
      },
      amended_at: { type: 'string', format: 'date-time' },
      medications: { type: 'array', items: { type: 'object', additionalProperties: true } },
      items_list: { type: 'array', items: { type: 'object', additionalProperties: true } },
      total_amount: { type: 'number', minimum: 0 },
      safety: {
        type: 'object',
        additionalProperties: false,
        required: ['safe', 'blockers', 'warnings'],
        properties: {
          safe: { type: 'boolean', enum: [true] },
          blockers: {
            type: 'array',
            maxItems: 0,
            items: { $ref: '#/components/schemas/PharmacyOrderSafetyFinding' },
          },
          warnings: {
            type: 'array',
            items: { $ref: '#/components/schemas/PharmacyOrderSafetyFinding' },
          },
        },
      },
      idempotent_replay: { type: 'boolean' },
    },
  },
  PharmacyRejectedPrescriptionAmendmentResponse:
    envelope('PharmacyRejectedPrescriptionAmendmentResult'),
  PharmacyOrderVerificationRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: {
      decision: {
        type: 'string',
        enum: ['verified', 'override', 'rejected'],
        default: 'verified',
      },
      override_reason: { type: 'string', minLength: 10, maxLength: 1000, nullable: true },
      manual_allergy_review_completed: {
        type: 'boolean',
        description:
          'Required and true for an in-charge break-glass override. The server records the actor, decision time, and unavailable safety sources.',
      },
      notes: { type: 'string', maxLength: 2000, nullable: true },
    },
    oneOf: [
      { properties: { decision: { enum: ['verified'] } } },
      {
        properties: {
          decision: { enum: ['override'] },
          manual_allergy_review_completed: { enum: [true] },
        },
        required: ['override_reason', 'manual_allergy_review_completed'],
      },
      {
        properties: {
          decision: { enum: ['rejected'] },
          notes: { type: 'string', minLength: 10, maxLength: 500 },
        },
        required: ['notes'],
      },
    ],
  },
  PharmacyOrderSafetyFinding: {
    type: 'object',
    additionalProperties: true,
    properties: {
      type: { type: 'string', nullable: true },
      severity: { type: 'string', nullable: true },
      message: { type: 'string', nullable: true },
    },
  },
  PharmacyOrderVerificationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['order', 'safety', 'patient_context'],
    properties: {
      order: { $ref: '#/components/schemas/PharmacyOrderMutationResult' },
      safety: {
        type: 'object',
        additionalProperties: false,
        required: ['safe', 'blockers', 'warnings'],
        properties: {
          safe: { type: 'boolean' },
          blockers: {
            type: 'array',
            items: { $ref: '#/components/schemas/PharmacyOrderSafetyFinding' },
          },
          warnings: {
            type: 'array',
            items: { $ref: '#/components/schemas/PharmacyOrderSafetyFinding' },
          },
        },
      },
      patient_context: { type: 'boolean' },
    },
  },
  PharmacyOrderVerificationResponse: envelope('PharmacyOrderVerificationResult'),
  PharmacyOrderDispatchRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['delivery_assignee_uid'],
    properties: {
      delivery_assignee_uid: { type: 'string', format: 'uuid' },
      dispensed_items: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/PharmacyOrderDeliveryAllocationLine' },
      },
      tpa_claim_id: positiveInt32,
      cap_override: {
        type: 'boolean',
        default: false,
        description: 'Restricted to PHARMACY_INCHARGE; requires cap_override_reason and is audited.',
      },
      cap_override_reason: { type: 'string', minLength: 10, maxLength: 500 },
    },
  },
  PharmacyOrderUnavailableLine: {
    type: 'object',
    additionalProperties: false,
    required: ['order_line_index', 'catalog_id'],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      catalog_id: positiveInt32,
      reason: { type: 'string', maxLength: 500, nullable: true },
    },
  },
  PharmacyOrderUnavailableRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      unavailable_items: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderUnavailableLine' },
      },
    },
  },
  PharmacyOrderCancelRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['cancellation_reason'],
    properties: {
      cancellation_reason: { type: 'string', minLength: 3, maxLength: 500 },
    },
  },
  PharmacyOrderFacilityAssignmentRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['facility_id'],
    properties: { facility_id: positiveInt32 },
  },
  PharmacyOrderLineIdentityMapping: {
    type: 'object',
    additionalProperties: false,
    required: ['order_line_index', 'prescription_line_index'],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
    },
  },
  PharmacyOrderLineIdentityResolutionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['line_mappings'],
    properties: {
      line_mappings: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { $ref: '#/components/schemas/PharmacyOrderLineIdentityMapping' },
      },
    },
  },
  PharmacyOrderLineIdentityResolutionLine: {
    type: 'object',
    additionalProperties: true,
    required: ['order_line_index', 'prescription_line_index', 'catalog_id'],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      catalog_id: positiveInt32,
      inventory_item_id: { ...positiveInt32, nullable: true },
      name: { type: 'string', nullable: true },
      medication_name: { type: 'string', nullable: true },
      generic_name: { type: 'string', nullable: true },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      ordered_qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      prescribed_qty: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      dispensed_qty: { type: 'number', minimum: 0, nullable: true },
      remaining_qty: { type: 'number', minimum: 0, nullable: true },
      price: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
      line_total: { type: 'number', minimum: 0, nullable: true },
    },
  },
  PharmacyOrderLineIdentityResolutionResult: {
    type: 'object',
    additionalProperties: true,
    required: [
      'id', 'status', 'items_list', 'facility_id', 'inventory_authority_version',
      'clinical_verification_status', 'idempotent_replay',
    ],
    properties: {
      id: positiveInt32,
      status: {
        type: 'string',
        enum: ['PENDING', 'CONFIRMED'],
      },
      items_list: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/PharmacyOrderLineIdentityResolutionLine' },
      },
      facility_id: positiveInt32,
      inventory_authority_version: { type: 'integer', minimum: 1 },
      clinical_verification_status: {
        type: 'string',
        enum: ['pending', 'verified', 'override', 'rejected'],
        nullable: true,
      },
      order_number: { type: 'string', nullable: true },
      patient_id: { ...positiveInt32, nullable: true },
      patient_name: { type: 'string', nullable: true },
      idempotent_replay: { type: 'boolean' },
    },
  },
  PharmacyOrderLineIdentityResolutionResponse:
    envelope('PharmacyOrderLineIdentityResolutionResult'),
  PharmacyPrescriptionCatalogSelection: {
    type: 'object',
    additionalProperties: false,
    properties: {
      catalog_id: positiveInt32,
      catalogId: positiveInt32,
      id: positiveInt32,
      name: { type: 'string', minLength: 1 },
      medication_name: { type: 'string', minLength: 1 },
      drug_name: { type: 'string', minLength: 1 },
    },
    anyOf: [
      { required: ['catalog_id'] },
      { required: ['catalogId'] },
      { required: ['id'] },
    ],
  },
  PharmacyPrescriptionCatalogSelectionMap: {
    type: 'object',
    additionalProperties: {
      oneOf: [
        positiveInt32,
        { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelection' },
      ],
    },
  },
  PharmacyPrescriptionCatalogSelectionList: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    items: { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelection' },
  },
  PharmacyPrescriptionOrderRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      delivery_type: { type: 'string', enum: ['delivery', 'counter'] },
      dispense_type: {
        type: 'string',
        enum: ['delivery', 'counter'],
        deprecated: true,
        description: 'Backward-compatible alias for delivery_type.',
      },
      delivery_address: { type: 'string', minLength: 1, maxLength: 1000, nullable: true },
      delivery_phone: { type: 'string', minLength: 10, maxLength: 20, nullable: true },
      catalog_id: positiveInt32,
      catalog_overrides: {
        oneOf: [
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionList' },
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionMap' },
        ],
      },
      catalogOverrides: {
        oneOf: [
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionList' },
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionMap' },
        ],
        deprecated: true,
      },
      catalog_selections: {
        oneOf: [
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionList' },
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionMap' },
        ],
      },
      catalogSelections: {
        oneOf: [
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionList' },
          { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionMap' },
        ],
        deprecated: true,
      },
      items: { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionList' },
      medications: { $ref: '#/components/schemas/PharmacyPrescriptionCatalogSelectionList' },
    },
  },
  PharmacyPrescriptionOrderResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'uid', 'tenant_id', 'facility_id', 'patient_id', 'patient_name',
      'patient_phone', 'status', 'order_note', 'total_amount', 'created_at',
      'updated_at', 'order_number', 'delivery_type',
    ],
    properties: {
      id: positiveInt32,
      uid: { type: 'string', format: 'uuid' },
      tenant_id: { type: 'string', format: 'uuid' },
      facility_id: positiveInt32,
      patient_id: positiveInt32,
      patient_name: { type: 'string' },
      patient_phone: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['PENDING'] },
      order_note: { type: 'string' },
      total_amount: nonNegativeMoney,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      order_number: { type: 'string' },
      delivery_type: { type: 'string', enum: ['delivery', 'counter'] },
    },
  },
  PharmacyPrescriptionOrderResponse: envelope('PharmacyPrescriptionOrderResult'),
  PharmacyPackLabelMedication: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'dose', 'frequency', 'route', 'days'],
    properties: {
      name: { type: 'string' },
      dose: { type: 'string', nullable: true },
      frequency: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      days: {
        oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }],
        nullable: true,
      },
    },
  },
  PharmacyPackLabelResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_id', 'order_number', 'pack_barcode', 'patient',
      'items', 'verification', 'generated_at',
    ],
    properties: {
      order_id: positiveInt32,
      order_number: { type: 'string', nullable: true },
      pack_barcode: { type: 'string' },
      patient: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'uid', 'name'],
        properties: {
          id: { ...positiveInt32, nullable: true },
          uid: { type: 'string', format: 'uuid', nullable: true },
          name: { type: 'string', nullable: true },
        },
      },
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyPackLabelMedication' },
      },
      verification: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'verified_by', 'verified_at'],
        properties: {
          status: { type: 'string', enum: ['verified', 'override'] },
          verified_by: { type: 'string', format: 'uuid', nullable: true },
          verified_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
  PharmacyPackLabelResponse: envelope('PharmacyPackLabelResult'),
  PharmacyDispenseLabelResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_number', 'order_id', 'patient', 'items', 'partial_dispense',
      'partial_reason', 'payment', 'receipt_delivery', 'confirmation_notes',
      'dispensed_at', 'measuring_guide',
    ],
    properties: {
      order_number: { type: 'string', nullable: true },
      order_id: positiveInt32,
      patient: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'phone', 'age_years', 'weight_kg', 'allergies'],
        properties: {
          name: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          age_years: { type: 'integer', minimum: 0, nullable: true },
          weight_kg: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true },
          allergies: { type: 'array', items: { type: 'string' } },
        },
      },
      items: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      partial_dispense: { type: 'boolean' },
      partial_reason: { type: 'string', nullable: true },
      payment: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'mode', 'amount_collected', 'total_amount', 'metadata'],
        properties: {
          status: { type: 'string', nullable: true },
          mode: { type: 'string', nullable: true },
          amount_collected: { type: 'number', minimum: 0, nullable: true },
          total_amount: { type: 'number', minimum: 0, nullable: true },
          metadata: { type: 'object', additionalProperties: true, nullable: true },
        },
      },
      receipt_delivery: { type: 'string', nullable: true },
      confirmation_notes: { type: 'string', nullable: true },
      dispensed_at: { type: 'string', format: 'date-time', nullable: true },
      measuring_guide: { type: 'object', additionalProperties: { type: 'string' }, nullable: true },
    },
  },
  PharmacyDispenseLabelResponse: envelope('PharmacyDispenseLabelResult'),

  PharmacyOrderInventoryAllocation: {
    type: 'object',
    additionalProperties: false,
    required: ['quantity'],
    properties: {
      inventory_batch_id: { type: 'integer', minimum: 1 },
      batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
      witness_approval_id: {
        oneOf: [
          { type: 'integer', minimum: 1 },
          { type: 'string', pattern: '^[1-9][0-9]*$' },
        ],
      },
    },
    anyOf: [
      { required: ['inventory_batch_id'] },
      { required: ['batch_id'] },
    ],
  },
  PharmacyOrderDeliveryAllocationLine: {
    type: 'object',
    additionalProperties: false,
    required: ['order_line_index', 'catalog_id', 'inventory_item_id'],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      catalog_id: { type: 'integer', minimum: 1 },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_allocations: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/PharmacyOrderInventoryAllocation' },
      },
    },
  },
  PharmacyOrderDeliveryRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['handoff_token'],
    properties: {
      handoff_token: { type: 'string', minLength: 20, maxLength: 200 },
      break_glass_reason: { type: 'string', minLength: 10, maxLength: 500 },
    },
  },
  PharmacyDeliveryHandoffReissueRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 10, maxLength: 500 },
      delivery_assignee_uid: { type: 'string', format: 'uuid' },
    },
  },
  PharmacyDeliveryReturnRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 10, maxLength: 500 },
    },
  },
  PharmacyDeliveryReturnCompletionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['disposition', 'reason'],
    properties: {
      disposition: { type: 'string', enum: ['returned', 'quarantined'] },
      reason: { type: 'string', minLength: 10, maxLength: 500 },
    },
  },
  PharmacyAssignedDelivery: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'order_number', 'facility_id', 'delivery_assignee_uid',
      'delivery_handoff_generation', 'delivery_custody_status',
      'delivery_tracking_active',
    ],
    properties: {
      id: positiveInt32,
      order_number: { type: 'string' },
      patient_name: { type: 'string', nullable: true },
      delivery_address: { type: 'string', nullable: true },
      delivery_lat: { type: 'number', minimum: -90, maximum: 90, nullable: true },
      delivery_lng: { type: 'number', minimum: -180, maximum: 180, nullable: true },
      estimated_delivery_mins: { type: 'integer', minimum: 0, nullable: true },
      delivery_distance_km: { type: 'number', minimum: 0, nullable: true },
      delivery_tracking_active: { type: 'boolean' },
      dispatched_at: { type: 'string', format: 'date-time', nullable: true },
      facility_id: positiveInt32,
      delivery_assignee_uid: { type: 'string', format: 'uuid' },
      delivery_handoff_generation: { type: 'integer', minimum: 1 },
      delivery_custody_status: {
        type: 'string',
        enum: ['in_transit', 'return_pending'],
      },
    },
  },
  PharmacyAssignedDeliveryList: {
    type: 'object',
    additionalProperties: false,
    required: ['deliveries'],
    properties: {
      deliveries: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyAssignedDelivery' },
      },
    },
  },
  PharmacyAssignedDeliveryResponse: envelope('PharmacyAssignedDeliveryList'),
  PharmacyDeliveryAssignee: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'name', 'grant_version'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      phone: { type: 'string', nullable: true },
      grant_version: { type: 'integer', minimum: 1 },
    },
  },
  PharmacyDeliveryAssigneeList: {
    type: 'object',
    additionalProperties: false,
    required: ['facility_id', 'delivery_assignees'],
    properties: {
      facility_id: positiveInt32,
      delivery_assignees: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyDeliveryAssignee' },
      },
    },
  },
  PharmacyDeliveryAssigneeResponse: envelope('PharmacyDeliveryAssigneeList'),
  PharmacyCounterDispenseLine: {
    type: 'object',
    additionalProperties: false,
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      catalog_id: { type: 'integer', minimum: 1 },
      name: { type: 'string', minLength: 1 },
      medication_name: { type: 'string', minLength: 1 },
      drug_name: { type: 'string', minLength: 1 },
      dispensed_quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
      dispensed_qty: { type: 'number', minimum: 0, exclusiveMinimum: true },
      qty: { type: 'number', minimum: 0, exclusiveMinimum: true },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
      dispensed_quantity_ml: { type: 'number', minimum: 0, exclusiveMinimum: true },
      prescribed_dose: { type: 'string', nullable: true },
      child_weight_kg: { type: 'number', minimum: 0, nullable: true },
      measuring_instruction: { type: 'string', nullable: true },
      label_instruction: { type: 'string', nullable: true },
      instructions: { type: 'string', nullable: true },
      batch_no: { type: 'string', nullable: true },
      expiry_date: { type: 'string', format: 'date', nullable: true },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_allocations: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/PharmacyOrderInventoryAllocation' },
      },
    },
    required: ['order_line_index', 'catalog_id'],
  },
  PharmacyCounterDispenseRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['payment_mode', 'amount_collected'],
    properties: {
      dispensed_items: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/PharmacyCounterDispenseLine' },
      },
      payment_mode: { type: 'string', enum: PHARMACY_PAYMENT_MODES },
      payment_method: { type: 'string', enum: PHARMACY_PAYMENT_MODES },
      amount_collected: { type: 'number', minimum: 0 },
      partial_dispense: { type: 'boolean' },
      partial_reason: { type: 'string', nullable: true },
      confirmation_notes: { type: 'string', nullable: true },
      receipt_delivery: { type: 'string', enum: ['phone', 'print', 'email', 'none'] },
      guardian_acknowledged: { type: 'boolean' },
      quantity_mismatch_acknowledged: { type: 'boolean' },
      mismatch_reason: { type: 'string', nullable: true },
      insurer: {
        type: 'string',
        nullable: true,
        description: 'Display metadata only; never accepted as funding authority.',
      },
      policy_number: {
        type: 'string',
        nullable: true,
        description: 'Display metadata only; never accepted as funding authority.',
      },
      tpa_reference: { type: 'string', minLength: 1, maxLength: 160 },
      cap_override: {
        type: 'boolean',
        default: false,
        description: 'Restricted to PHARMACY_INCHARGE; requires cap_override_reason and is audited.',
      },
      cap_override_reason: { type: 'string', minLength: 10, maxLength: 500 },
    },
    anyOf: [
      { properties: { payment_mode: { enum: ['cash', 'card', 'upi', 'wallet', 'none'] } } },
      {
        properties: { payment_mode: { enum: ['insurance', 'corporate_tpa'] } },
        required: ['tpa_reference'],
      },
    ],
  },
  PharmacyBodyCounterDispenseRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['payment_mode', 'amount_collected'],
    properties: {
      order_id: { type: 'integer', minimum: 1 },
      orderId: { type: 'integer', minimum: 1 },
      id: { type: 'integer', minimum: 1 },
      dispensed_items: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/PharmacyCounterDispenseLine' } },
      payment_mode: { type: 'string', enum: PHARMACY_PAYMENT_MODES },
      payment_method: { type: 'string', enum: PHARMACY_PAYMENT_MODES },
      amount_collected: { type: 'number', minimum: 0 },
      partial_dispense: { type: 'boolean' },
      partial_reason: { type: 'string', nullable: true },
      confirmation_notes: { type: 'string', nullable: true },
      receipt_delivery: { type: 'string', enum: ['phone', 'print', 'email', 'none'] },
      guardian_acknowledged: { type: 'boolean' },
      quantity_mismatch_acknowledged: { type: 'boolean' },
      mismatch_reason: { type: 'string', nullable: true },
      insurer: {
        type: 'string',
        nullable: true,
        description: 'Display metadata only; never accepted as funding authority.',
      },
      policy_number: {
        type: 'string',
        nullable: true,
        description: 'Display metadata only; never accepted as funding authority.',
      },
      tpa_reference: { type: 'string', minLength: 1, maxLength: 160 },
      cap_override: {
        type: 'boolean',
        default: false,
        description: 'Restricted to PHARMACY_INCHARGE; requires cap_override_reason and is audited.',
      },
      cap_override_reason: { type: 'string', minLength: 10, maxLength: 500 },
    },
    anyOf: [
      { required: ['order_id'] },
      { required: ['orderId'] },
      { required: ['id'] },
    ],
    allOf: [{
      anyOf: [
        { properties: { payment_mode: { enum: ['cash', 'card', 'upi', 'wallet', 'none'] } } },
        {
          properties: { payment_mode: { enum: ['insurance', 'corporate_tpa'] } },
          required: ['tpa_reference'],
        },
      ],
    }],
  },

  PharmacyOrderDispenseInventoryEvidence: {
    type: 'object',
    additionalProperties: false,
    required: [
      'inventory_item_id', 'inventory_batch_id', 'quantity',
      'unit_price', 'line_total', 'movement_id',
    ],
    properties: {
      inventory_item_id: { type: 'integer', minimum: 1 },
      facility_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      batch_number: { type: 'string', nullable: true },
      lot_number: { type: 'string', nullable: true },
      expiry_date: { type: 'string', format: 'date', nullable: true },
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
      unit_price: { type: 'number', minimum: 0, exclusiveMinimum: true },
      line_total: { type: 'number', minimum: 0 },
      movement_id: { type: 'integer', minimum: 1 },
      register_entry_id: { type: 'integer', minimum: 1, nullable: true },
    },
  },
  PharmacyOrderDispensedLine: {
    type: 'object',
    additionalProperties: true,
    required: [
      'order_line_index', 'catalog_id', 'inventory_item_id',
      'ordered_qty', 'dispensed_qty', 'remaining_qty',
      'inventory_dispensed_quantity', 'inventory_remaining_quantity',
      'inventory_billable_total', 'line_total',
    ],
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      catalog_id: { type: 'integer', minimum: 1 },
      inventory_item_id: { type: 'integer', minimum: 1 },
      ordered_qty: { type: 'number', minimum: 0, exclusiveMinimum: true },
      dispensed_qty: { type: 'number', minimum: 0 },
      remaining_qty: { type: 'number', minimum: 0 },
      inventory_dispensed_quantity: { type: 'number', minimum: 0 },
      inventory_remaining_quantity: { type: 'number', minimum: 0 },
      price: { type: 'number', minimum: 0, exclusiveMinimum: true },
      inventory_billable_total: { type: 'number', minimum: 0 },
      line_total: { type: 'number', minimum: 0 },
      inventory_allocation_evidence: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderDispenseInventoryEvidence' },
      },
    },
  },
  PharmacyOrderDispenseLabelItem: {
    type: 'object',
    additionalProperties: true,
    properties: {
      name: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      dose: { type: 'string', nullable: true },
      frequency: { type: 'string', nullable: true },
      duration: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      dispensed_qty: { type: 'number', minimum: 0 },
      inventory_item_id: { type: 'integer', minimum: 1, nullable: true },
      inventory_allocation_evidence: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderDispenseInventoryEvidence' },
      },
    },
  },
  PharmacyOrderDispenseLabel: {
    type: 'object',
    additionalProperties: false,
    required: ['order_number', 'patient_name', 'dispensed_at', 'partial_dispense', 'items', 'inventory_allocations'],
    properties: {
      order_number: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      dispensed_at: { type: 'string', format: 'date-time' },
      partial_dispense: { type: 'boolean' },
      partial_reason: { type: 'string', nullable: true },
      items: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderDispenseLabelItem' } },
      inventory_allocations: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderDispenseInventoryEvidence' },
      },
    },
  },
  PharmacyOrderDeliveryResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'status', 'items_list', 'dispensed_medications',
      'inventory_allocations', 'dispense_label', 'total_amount',
      'pack_barcode', 'pack_barcode_pending',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      uid: { type: 'string', format: 'uuid', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_id: { type: 'integer', minimum: 1, nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      order_number: { type: 'string', nullable: true },
      order_note: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['DELIVERED'] },
      total_amount: {
        oneOf: [
          { type: 'number', minimum: 0 },
          { type: 'string', pattern: '^\\d+(?:\\.\\d+)?$' },
        ],
      },
      items_list: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderDispensedLine' } },
      dispensed_medications: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderDispensedLine' } },
      inventory_allocations: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyOrderDispenseInventoryEvidence' },
      },
      dispense_label: { $ref: '#/components/schemas/PharmacyOrderDispenseLabel' },
      delivered_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      pack_barcode: { type: 'string', nullable: true },
      pack_barcode_pending: { type: 'boolean' },
      pack_barcode_recovery_endpoint: { type: 'string', nullable: true },
    },
  },
  PharmacyOrderDeliveryResponse: envelope('PharmacyOrderDeliveryResult'),
  PharmacyCounterDispenseResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'status', 'delivery_type', 'items_list', 'dispensed_medications',
      'total_amount', 'payment_status', 'partial_dispense', 'dispense_label',
      'pack_barcode', 'pack_barcode_pending',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      uid: { type: 'string', format: 'uuid', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_id: { type: 'integer', minimum: 1, nullable: true },
      patient_name: { type: 'string', nullable: true },
      order_number: { type: 'string', nullable: true },
      order_note: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['PARTIALLY_DISPENSED', 'DISPENSED'] },
      delivery_type: { type: 'string', enum: ['counter'] },
      total_amount: {
        oneOf: [
          { type: 'number', minimum: 0 },
          { type: 'string', pattern: '^\\d+(?:\\.\\d+)?$' },
        ],
      },
      items_list: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderDispensedLine' } },
      dispensed_medications: { type: 'array', items: { $ref: '#/components/schemas/PharmacyOrderDispensedLine' } },
      payment_status: { type: 'string', enum: ['paid', 'partial', 'pending'] },
      payment_mode: { type: 'string', enum: PHARMACY_PAYMENT_MODES, nullable: true },
      amount_collected: {
        oneOf: [
          { type: 'number', minimum: 0 },
          { type: 'string', pattern: '^\\d+(?:\\.\\d+)?$' },
        ],
        nullable: true,
      },
      partial_dispense: { type: 'boolean' },
      partial_reason: { type: 'string', nullable: true },
      receipt_delivery: { type: 'string', nullable: true },
      payment_metadata: { type: 'object', additionalProperties: true, nullable: true },
      dispense_label: { $ref: '#/components/schemas/PharmacyOrderDispenseLabel' },
      confirmation_notes: { type: 'string', nullable: true },
      dispensed_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      pack_barcode: { type: 'string', nullable: true },
      pack_barcode_pending: { type: 'boolean' },
      pack_barcode_recovery_endpoint: { type: 'string', nullable: true },
    },
  },
  PharmacyCounterDispenseResponse: envelope('PharmacyCounterDispenseResult'),
  PharmacyOrderDispenseRecoveryDetails: {
    type: 'object',
    additionalProperties: true,
    properties: {
      next_action: {
        type: 'string',
        description: 'Machine-readable recovery action. Clients must render a localized owned workflow, never this raw token.',
      },
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      catalog_id: { type: 'integer', minimum: 1 },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      required_quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
      payment_mode: { type: 'string', enum: PHARMACY_PAYMENT_MODES, nullable: true },
      payment_status: { type: 'string', nullable: true },
      amount_collected: { ...nonNegativeMoney, nullable: true },
      total_amount: { ...nonNegativeMoney, nullable: true },
      tpa_reference: { type: 'string', nullable: true },
      approved_funding_amount: { ...nonNegativeMoney, nullable: true },
      funding_shortfall: { ...nonNegativeMoney, nullable: true },
      funding_recovery: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/PharmacyFundingRecoveryTask' }],
      },
      clinical_verification_status: {
        type: 'string',
        enum: ['pending', 'verified', 'override', 'rejected'],
        nullable: true,
      },
      manual_allergy_review_required: { type: 'boolean', nullable: true },
      recovery_action: {
        oneOf: [
          { type: 'string' },
          { type: 'object', additionalProperties: true },
        ],
      },
      candidate_order_line_indexes: { type: 'array', items: { type: 'integer', minimum: 0 } },
      candidate_prescription_line_indexes: { type: 'array', items: { type: 'integer', minimum: 0 } },
      inventory_item_candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },
  PharmacyOrderDispenseErrorResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string', nullable: true },
      details: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/PharmacyOrderDispenseRecoveryDetails' }],
      },
      requestId: { type: 'string', nullable: true },
    },
  },

  // =========================================================================
  // POST /dispense-substitution (+ its Schedule X / narcotic witness flow)
  // =========================================================================
  // The witness fingerprint binds to exactly the client-known substitution
  // fields (witness_approval_id / credentials excluded) — see
  // PharmacySubstitutionWitnessApprovalRequest, which carries that shape.
  PharmacyDispenseSubstitutionRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_id', 'prescription_id', 'order_line_index',
      'prescription_line_index', 'patient_uid',
      'inventory_item_id', 'inventory_batch_id',
      'quantity', 'original_catalog_id', 'final_catalog_id',
      'payment_mode', 'amount_collected',
    ],
    properties: {
      order_id: { type: 'integer', minimum: 1 },
      prescription_id: { type: 'integer', minimum: 1 },
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'integer', minimum: 1, nullable: true },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0.0001 },
      original_catalog_id: { type: 'integer', minimum: 1 },
      final_catalog_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', nullable: true, maxLength: 500 },
      payment_mode: {
        type: 'string',
        enum: ['cash', 'card', 'upi', 'wallet', 'insurance', 'corporate_tpa'],
        description:
          'Required for every counter or delivery substitution before stock issue. Insurance/TPA requires exact server-side claim-line allocation.',
      },
      amount_collected: {
        type: 'number',
        minimum: 0,
        description: 'Cumulative amount collected against the server-derived adjusted order total.',
      },
      tpa_reference: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
        description:
          'Claim reference lookup only; funding is accepted solely from the matching approved invoice-line decision.',
      },
      witness_approval_id: {
        oneOf: [
          { type: 'integer', minimum: 1 },
          { type: 'string', pattern: '^[1-9][0-9]*$' },
        ],
        nullable: true,
        description:
          'Approved, unexpired one-time witness approval from the two-person substitution witness flow. Required when the dispensed inventory item is Schedule X / narcotic; caller-selected witness identity is never accepted.',
      },
    },
    anyOf: [
      {
        properties: {
          payment_mode: { enum: ['cash', 'card', 'upi', 'wallet'] },
        },
      },
      {
        properties: {
          payment_mode: { enum: ['insurance', 'corporate_tpa'] },
        },
        required: ['tpa_reference'],
      },
    ],
  },

  PharmacyDispenseSubstitutionResult: {
    type: 'object',
    required: [
      'movement_id', 'order_id', 'prescription_id',
      'order_line_index', 'prescription_line_index',
      'original_catalog_id', 'final_catalog_id', 'quantity',
      'remaining_quantity', 'fulfilment_status', 'billable_subtotal',
      'batch_evidence', 'pack_barcode',
    ],
    properties: {
      movement_id: { type: 'integer' },
      order_id: { type: 'integer' },
      prescription_id: { type: 'integer' },
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      original_catalog_id: { type: 'integer' },
      final_catalog_id: { type: 'integer' },
      quantity: { type: 'number' },
      remaining_quantity: { type: 'number', minimum: 0 },
      fulfilment_status: { type: 'string', enum: ['partial', 'fulfilled'] },
      billable_subtotal: { type: 'number', minimum: 0 },
      batch_evidence: {
        type: 'object',
        required: ['inventory_item_id', 'inventory_batch_id'],
        properties: {
          inventory_item_id: { type: 'integer' },
          inventory_batch_id: { type: 'integer' },
          batch_number: { type: 'string', nullable: true },
          lot_number: { type: 'string', nullable: true },
          expiry_date: { type: 'string', format: 'date', nullable: true },
        },
      },
      pack_barcode: { type: 'string', nullable: true },
      pack_barcode_pending: { type: 'boolean' },
      pack_barcode_recovery_endpoint: { type: 'string', nullable: true },
      idempotent_replay: { type: 'boolean' },
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
      'order_id', 'prescription_id', 'order_line_index',
      'prescription_line_index', 'patient_uid',
      'inventory_item_id', 'inventory_batch_id',
      'quantity', 'original_catalog_id', 'final_catalog_id',
      'payment_mode', 'amount_collected',
    ],
    description:
      'The exact prospective substitution payload to bind to a short-lived pending witness approval. witness_approval_id is not accepted on this pre-approval request.',
    properties: {
      order_id: { type: 'integer', minimum: 1 },
      prescription_id: { type: 'integer', minimum: 1 },
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0 },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'integer', minimum: 1, nullable: true },
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0.0001 },
      original_catalog_id: { type: 'integer', minimum: 1 },
      final_catalog_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', nullable: true, maxLength: 500 },
      payment_mode: {
        type: 'string',
        enum: ['cash', 'card', 'upi', 'wallet', 'insurance', 'corporate_tpa'],
      },
      amount_collected: { type: 'number', minimum: 0 },
      tpa_reference: { type: 'string', minLength: 1, maxLength: 160 },
    },
    anyOf: [
      {
        properties: {
          payment_mode: { enum: ['cash', 'card', 'upi', 'wallet'] },
        },
      },
      {
        properties: {
          payment_mode: { enum: ['insurance', 'corporate_tpa'] },
        },
        required: ['tpa_reference'],
      },
    ],
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

  // Counter sale and substitution retain the broad clinical witness roster.
  PharmacySubstitutionWitnessApprovalResponse: envelope('PharmacyCounterSaleWitnessApproval'),

  PharmacyOrderControlledWitnessPayload: {
    type: 'object',
    additionalProperties: false,
    required: [
      'contract',
      'order_id',
      'order_line_index',
      'order_inventory_authority_version',
      'order_status',
      'operation',
      'facility_id',
      'requester_facility_grant_id',
      'requester_facility_role',
      'order_catalog_id',
      'order_ordered_quantity',
      'order_dispensed_quantity',
      'order_remaining_quantity',
      'inventory_item_id',
      'inventory_batch_id',
      'batch_number',
      'lot_number',
      'expiry_date',
      'batch_safety_contract',
      'quantity',
      'patient_uid',
      'prescription_id',
      'prescription_number',
      'prescription_revision',
      'prescription_status',
      'prescription_lifecycle_status',
      'prescriber_user_id',
      'prescriber_uid',
      'prescription_signed_at',
      'prescription_signed_by',
      'prescription_locked_at',
      'prescription_locked_by',
      'prescription_line_index',
      'prescription_catalog_id',
      'prescription_ordered_quantity',
      'prescription_dispensed_quantity',
      'prescription_remaining_quantity',
    ],
    properties: {
      contract: {
        type: 'string',
        enum: ['pharmacy_order_inventory_dispense_witness_v1'],
      },
      order_id: positiveInt32,
      order_line_index: { type: 'integer', minimum: 0 },
      order_inventory_authority_version: { type: 'integer', minimum: 1 },
      order_status: {
        type: 'string',
        enum: ['PENDING', 'CONFIRMED', 'PREPARING', 'PARTIALLY_DISPENSED'],
      },
      operation: { type: 'string', enum: ['counter', 'delivery'] },
      facility_id: positiveInt32,
      requester_facility_grant_id: {
        ...positiveSignedInt64String,
        description: 'ACTIVE facility grant of the authenticated dispensing operator.',
      },
      requester_facility_role: {
        type: 'string',
        enum: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      },
      order_catalog_id: positiveInt32,
      order_ordered_quantity: {
        type: 'number', minimum: 0.0001, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
      order_dispensed_quantity: {
        type: 'number', minimum: 0, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
      order_remaining_quantity: {
        type: 'number', minimum: 0, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      batch_number: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
      lot_number: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
      expiry_date: { type: 'string', format: 'date' },
      batch_safety_contract: {
        type: 'string',
        enum: ['usable_in_stock_nonexpired_sufficient_stock_v1'],
      },
      quantity: {
        type: 'number', minimum: 0.0001, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
      patient_uid: { type: 'string', format: 'uuid' },
      prescription_id: positiveInt32,
      prescription_number: { type: 'string', minLength: 1, nullable: true },
      prescription_revision: { type: 'integer', minimum: 1 },
      prescription_status: { type: 'string', enum: ['active', 'pharmacy_linked'] },
      prescription_lifecycle_status: { type: 'string', enum: ['signed'] },
      prescriber_user_id: positiveInt32,
      prescriber_uid: { type: 'string', format: 'uuid' },
      prescription_signed_at: { type: 'string', format: 'date-time' },
      prescription_signed_by: { type: 'string', format: 'uuid' },
      prescription_locked_at: { type: 'string', format: 'date-time' },
      prescription_locked_by: { type: 'string', format: 'uuid' },
      prescription_line_index: { type: 'integer', minimum: 0 },
      prescription_catalog_id: positiveInt32,
      prescription_ordered_quantity: {
        type: 'number', minimum: 0.0001, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
      prescription_dispensed_quantity: {
        type: 'number', minimum: 0, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
      prescription_remaining_quantity: {
        type: 'number', minimum: 0, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
    },
  },

  PharmacyOrderControlledWitnessApproval: facilityBoundWitnessApprovalSchema({
    scope: 'pharmacy_order_inventory_dispense',
    payloadSchema: { $ref: '#/components/schemas/PharmacyOrderControlledWitnessPayload' },
  }),

  PharmacyOrderControlledWitnessSelection: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_line_index', 'inventory_item_id', 'inventory_batch_id', 'quantity',
    ],
    description:
      'Exact order-line and batch selectors. Patient, facility, prescription, catalog, performer and witness authority are server-derived and are not accepted from the caller.',
    properties: {
      order_line_index: { type: 'integer', minimum: 0 },
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      quantity: {
        type: 'number', minimum: 0.0001, maximum: 9999999999.9999, multipleOf: 0.0001,
      },
    },
  },

  PharmacyOrderControlledWitnessDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['selection', 'employeeId', 'password'],
    properties: {
      selection: {
        $ref: '#/components/schemas/PharmacyOrderControlledWitnessSelection',
      },
      employeeId: {
        type: 'string',
        pattern: '^[A-Z0-9-]{3,20}$',
        description:
          'Employee ID of the second active pharmacy operator holding an ACTIVE grant for the exact order facility, authenticated without replacing the dispensing pharmacist session.',
      },
      password: {
        type: 'string',
        format: 'password',
        minLength: 6,
        maxLength: 100,
        writeOnly: true,
        description:
          'Independent witness password. It is deleted from the request body after authentication and never enters the idempotency fingerprint.',
      },
    },
  },

  PharmacyOrderControlledWitnessResponse: envelope('PharmacyOrderControlledWitnessApproval'),

  PharmacySupplyStockMovementErrorResponse: {
    type: 'object',
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string', nullable: true },
      details: { type: 'object', additionalProperties: true, nullable: true },
      requestId: { type: 'string', nullable: true },
    },
  },
  PharmacySupplyStockMovementRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'inventory_item_id', 'inventory_batch_id', 'movement_kind', 'quantity_delta',
    ],
    properties: {
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1 },
      movement_kind: {
        type: 'string',
        enum: ['receive', 'transfer_in', 'return', 'adjust_increase'],
      },
      quantity_delta: { type: 'number', minimum: 0, exclusiveMinimum: true },
      reference_type: { type: 'string', minLength: 1, maxLength: 60, nullable: true },
      reference_id: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
      notes: { type: 'string', maxLength: 8000, nullable: true },
      metadata: { type: 'object', additionalProperties: true, nullable: true },
    },
  },
  PharmacySupplyStockMovementResult: {
    type: 'object',
    additionalProperties: true,
    required: [
      'id', 'tenant_id', 'inventory_item_id', 'inventory_batch_id',
      'movement_kind', 'quantity_delta',
    ],
    properties: {
      id: positiveInt32,
      tenant_id: { type: 'string', format: 'uuid' },
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      movement_kind: {
        type: 'string',
        enum: ['receive', 'transfer_in', 'return', 'adjust_increase'],
      },
      quantity_delta: { type: 'number', minimum: 0, exclusiveMinimum: true },
      reference_type: { type: 'string', nullable: true },
      reference_id: { type: 'string', nullable: true },
      performed_by: { type: 'string', format: 'uuid', nullable: true, readOnly: true },
      notes: { type: 'string', nullable: true },
      metadata: { type: 'object', additionalProperties: true, nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PharmacySupplyStockMovementResponse: envelope('PharmacySupplyStockMovementResult'),
  PharmacySupplyGoodsReceiptLineQcRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['qc_status'],
    properties: {
      qc_status: { type: 'string', enum: ['passed', 'failed'] },
      qc_notes: { type: 'string', maxLength: 8000, nullable: true },
    },
  },
  PharmacySupplyGoodsReceiptLineQcResult: {
    type: 'object',
    additionalProperties: false,
    required: ['goods_receipt_item', 'batch'],
    properties: {
      goods_receipt_item: { type: 'object', additionalProperties: true },
      batch: { type: 'object', additionalProperties: true },
    },
  },
  PharmacySupplyGoodsReceiptLineQcResponse:
    envelope('PharmacySupplyGoodsReceiptLineQcResult'),
  PharmacySupplyGoodsReceiptTransitionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['reject', 'finalize', 'close', 'archive'] },
    },
  },
  PharmacySupplyGoodsReceiptTransitionResult: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'facility_id', 'status'],
    properties: {
      id: positiveInt32,
      facility_id: positiveInt32,
      status: {
        type: 'string',
        enum: [
          'received', 'qc_pending', 'qc_failed', 'qc_passed', 'partial',
          'closed', 'rejected', 'archived',
        ],
      },
    },
  },
  PharmacySupplyGoodsReceiptTransitionResponse:
    envelope('PharmacySupplyGoodsReceiptTransitionResult'),
  PharmacyWardControlledWitnessRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'allocation_id'],
    properties: {
      item_id: positiveInt32,
      allocation_id: { type: 'string', pattern: '^[1-9][0-9]*$' },
    },
  },
  PharmacyWardControlledWitnessDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'allocation_id'],
    properties: {
      item_id: positiveInt32,
      allocation_id: { type: 'string', pattern: '^[1-9][0-9]*$' },
      employeeId: { type: 'string', minLength: 1, maxLength: 100, nullable: true },
      password: { type: 'string', minLength: 1, maxLength: 256, nullable: true, writeOnly: true },
    },
  },
  PharmacyWardControlledWitnessResult: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'witness_payload'],
    properties: {
      id: { type: 'string', pattern: '^[1-9][0-9]*$' },
      status: { type: 'string', nullable: true },
      witness_payload: {
        type: 'object',
        additionalProperties: false,
        required: [
          'ward_indent_id', 'ward_indent_item_id', 'allocation_id',
          'inventory_item_id', 'inventory_batch_id', 'quantity', 'patient_uid',
          'clinical_order_id', 'catalog_id', 'reference_id',
        ],
        properties: {
          ward_indent_id: positiveInt32,
          ward_indent_item_id: positiveInt32,
          allocation_id: { type: 'string', pattern: '^[1-9][0-9]*$' },
          inventory_item_id: positiveInt32,
          inventory_batch_id: positiveInt32,
          quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
          patient_uid: { type: 'string', format: 'uuid' },
          clinical_order_id: positiveInt32,
          catalog_id: positiveInt32,
          reference_id: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  PharmacyWardControlledWitnessResponse: envelope('PharmacyWardControlledWitnessResult'),
  PharmacyWardControlledHandoffRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_version', 'item_evidence'],
    properties: {
      expected_version: { type: 'integer', minimum: 1 },
      item_evidence: {
        type: 'array',
        minItems: 1,
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['item_id'],
              properties: { item_id: positiveInt32 },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['item_id', 'witness_approval_id'],
              properties: {
                item_id: positiveInt32,
                witness_approval_id: {
                  type: 'string',
                  pattern: '^[1-9][0-9]*$',
                },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['item_id', 'historical_recovery'],
              properties: {
                item_id: positiveInt32,
                historical_recovery: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['movement_id', 'register_id', 'reason'],
                  properties: {
                    movement_id: positiveInt32,
                    register_id: positiveInt32,
                    reason: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 2000,
                      pattern: '\\S',
                      description:
                        'Trimmed nonblank pharmacy-in-charge reason recorded in the immutable recovery receipt.',
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  PharmacyWardApplySubstitutionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_version', 'inventory_selections'],
    properties: {
      expected_version: { type: 'integer', minimum: 1 },
      inventory_selections: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', additionalProperties: true },
      },
    },
  },
  PharmacyWardIndentMutationResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      message: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
      meta: { type: 'object', additionalProperties: true },
    },
  },
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
const pharmacyOrderIdPathSchema = positiveInt32;
const pharmacyCatalogIdPathSchema = positiveInt32;
const prescriptionIdPathSchema = positiveInt32;
const patientUidPathSchema = { type: 'string', format: 'uuid' };
const substitutionApprovalIdPathSchema = { type: 'string', pattern: '^[1-9][0-9]*$' };
const supplyStockMovementErrorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PharmacySupplyStockMovementErrorResponse' },
    },
  },
});
const pharmacyOrderDispenseErrorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PharmacyOrderDispenseErrorResponse' },
    },
  },
});
const pharmacyOrderDispenseErrorResponses = {
  400: pharmacyOrderDispenseErrorResponse(
    'The order state, line identity, quantity, payment, cap override, or batch evidence is invalid.',
  ),
  401: pharmacyOrderDispenseErrorResponse(
    'The staff session is missing, expired, or invalid.',
  ),
  403: pharmacyOrderDispenseErrorResponse(
    'The actor lacks dispense, controlled-custody, or TPA-cap override authority.',
  ),
  404: pharmacyOrderDispenseErrorResponse(
    'The tenant-scoped order, prescription, inventory item, batch, patient, or witness evidence was not found.',
  ),
  409: pharmacyOrderDispenseErrorResponse(
    'Authoritative verification, order, prescription, catalog, stock, or recovery evidence changed or requires governed recovery.',
  ),
  422: pharmacyOrderDispenseErrorResponse(
    'The Idempotency-Key was reused with different clinical intent or a line cannot be resolved authoritatively.',
  ),
  429: pharmacyOrderDispenseErrorResponse(
    'The authenticated actor or route has been rate limited.',
  ),
  500: pharmacyOrderDispenseErrorResponse(
    'The pre-commit dispense transaction failed without committing stock.',
  ),
  503: pharmacyOrderDispenseErrorResponse(
    'The idempotency store or another required fail-closed dependency was unavailable.',
  ),
};
const pharmacyOrderLifecycleErrorResponses = {
  400: pharmacyOrderDispenseErrorResponse(
    'The order identifier, facility context, lifecycle state, or request body is invalid.',
  ),
  401: pharmacyOrderDispenseErrorResponse('The authenticated session is missing or invalid.'),
  403: pharmacyOrderDispenseErrorResponse(
    'The actor lacks the tenant, patient, pharmacy, or facility authority required for this operation.',
  ),
  404: pharmacyOrderDispenseErrorResponse(
    'The tenant- and facility-scoped order or related clinical authority was not found.',
  ),
  409: pharmacyOrderDispenseErrorResponse(
    'The order, prescription, facility custody, verification version, funding, or inventory authority changed or needs governed recovery.',
  ),
  500: pharmacyOrderDispenseErrorResponse('The operation failed without a confirmed lifecycle transition.'),
  503: pharmacyOrderDispenseErrorResponse('A required fail-closed dependency was unavailable.'),
};
const pharmacyOrderIdempotentErrorResponses = {
  ...pharmacyOrderLifecycleErrorResponses,
  422: pharmacyOrderDispenseErrorResponse(
    'The Idempotency-Key was reused with a different tenant, order, or request body.',
  ),
};

const pharmacyOrderQueueQueryParameters = [
  {
    name: 'status',
    in: 'query',
    required: false,
    schema: { type: 'string' },
  },
  {
    name: 'from_date',
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'date' },
  },
  {
    name: 'to_date',
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'date' },
  },
];

const OPS = [
  ['GET /catalog', { response: 'PharmacyCatalogListResponse' }],
  ['GET /catalog/{id}/alternatives', {
    pathParameters: { id: pharmacyCatalogIdPathSchema },
    response: 'PharmacyAlternativesResponse',
  }],
  ['GET /catalog/{id}/dispensable-batches', {
    pathParameters: { id: pharmacyCatalogIdPathSchema },
  }],
  ['DELETE /catalog/{id}', {
    pathParameters: { id: pharmacyCatalogIdPathSchema },
  }],
  ['POST /ward-indents/{id}/substitutions/apply', {
    description:
      'A facility-granted pharmacy actor applies only clinician-approved substitutions, revalidates exact catalog and inventory authority, and replaces reservations atomically. Clinician approval itself never mutates stock.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyWardApplySubstitutionRequest',
    response: 'PharmacyWardIndentMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /ward-indents/{id}/controlled-handoff/witness-approvals', {
    description:
      'Creates a one-time witness request bound to the exact locked ward indent, controlled line, allocation, patient, clinical order, catalog, batch, quantity, facility, and requesting pharmacist.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyWardControlledWitnessRequest',
    response: 'PharmacyWardControlledWitnessResponse',
    additionalResponses: substitutionWitnessErrorResponses({ idempotent: true }),
  }],
  ['POST /ward-indents/{id}/controlled-handoff/witness-approvals/{approvalId}/approve', {
    description:
      'A separately authenticated eligible witness approves the unchanged exact ward allocation payload. The witness cannot be the dispensing actor.',
    pathParameters: {
      id: pharmacyOrderIdPathSchema,
      approvalId: substitutionApprovalIdPathSchema,
    },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyWardControlledWitnessDecisionRequest',
    response: 'PharmacyWardControlledWitnessResponse',
    additionalResponses: substitutionWitnessErrorResponses({ idempotent: true }),
  }],
  ['POST /ward-indents/{id}/controlled-handoff', {
    description:
      'Fresh handoffs atomically consume exact witness approvals when required, validate the active clinical-order prescriber and signed catalog identity, decrement the locked allocation batch, write the statutory register, link custody evidence, and advance the indent. An explicit pharmacy-in-charge historical recovery instead links one fully classified existing immutable movement/register evidence pair to the exact allocation without a second inventory decrement and writes an immutable recovery receipt.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyWardControlledHandoffRequest',
    response: 'PharmacyWardIndentMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['GET /orders', {
    description:
      'Lists the tenant queue under the sole active default pharmacy facility. Privileged facility-recovery roles also receive legacy NULL-facility rows with an explicit assignment target.',
    parameters: pharmacyOrderQueueQueryParameters,
    response: 'PharmacyOrderQueueResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/queue', {
    description: 'Alias for the governed tenant/facility pharmacy order queue.',
    parameters: pharmacyOrderQueueQueryParameters,
    response: 'PharmacyOrderQueueResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/{id}', {
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyOrderDetailResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/{id}/detail', {
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyOrderDetailResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/{id}/dispensable', {
    description:
      'Returns the exact order-line and prescription-line identity used by substitution, plus the current server-authoritative counter funding context.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyOrderDispensableContextResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/{id}/label', {
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyDispenseLabelResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/{id}/receipt', {
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyDispenseLabelResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/{id}/pack-label', {
    description:
      'Returns a pack label only while the current item hash and inventory-authority version still match the cleared clinical verification.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyPackLabelResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['POST /orders/{id}/confirm', {
    description:
      'Confirms a manual/photo order only from authoritative catalog and facility-inventory bindings. Prescription-bound order lines and prices remain immutable.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyOrderConfirmationRequest',
    response: 'PharmacyOrderMutationResponse',
    parameters: [substitutionIdempotencyKeyParameter],
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/verify', {
    description:
      'Records pharmacist clinical verification against the exact current order version and clinical-items SHA-256. Idempotency-Key is required.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderVerificationRequest',
    response: 'PharmacyOrderVerificationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/assign-facility', {
    description:
      'Governed recovery for a legacy NULL-facility order. Only pharmacy in-charge or tenant administration may bind it to the tenant\'s sole active default facility. Idempotency-Key is required.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderFacilityAssignmentRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/resolve-line-identities', {
    description:
      'Governed recovery for a legacy prescription-linked order whose stored lines lack exact stable order-line and prescription-line identities. Every stored order line must be mapped exactly once before preparation or dispense. Idempotency-Key is required.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderLineIdentityResolutionRequest',
    response: 'PharmacyOrderLineIdentityResolutionResponse',
    additionalResponses: {
      ...pharmacyOrderIdempotentErrorResponses,
      422: pharmacyOrderDispenseErrorResponse(
        'The mapping is incomplete, duplicates a line, conflicts with the linked prescription, or reuses an Idempotency-Key with a different request body.',
      ),
    },
  }],
  ['POST /orders/{id}/preparing', {
    description:
      'Moves a CONFIRMED order to PREPARING only after current clinical verification remains cleared.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/dispatch', {
    description:
      'Moves a verified CONFIRMED or PREPARING delivery order to DISPATCHED under the same facility authority.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderDispatchRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/controlled-dispense/witness-approvals', {
    description:
      'Creates a short-lived one-time witness request for an exact Schedule X or narcotic order allocation. The server resolves and fingerprints the active tenant patient, signed prescription line and remainder, facility grant, active performer, catalog-linked item and usable batch. Only a second active pharmacy operator holding an ACTIVE grant for this exact order facility may approve it. The retired standalone Inventory V2 dispense is not reopened. Idempotency-Key is required.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderControlledWitnessSelection',
    response: 'PharmacyOrderControlledWitnessResponse',
    additionalResponses: {
      ...pharmacyOrderIdempotentErrorResponses,
      429: pharmacyOrderDispenseErrorResponse(
        'The witness credential attempt was rate limited or locked.',
      ),
    },
  }],
  ['POST /orders/{id}/controlled-dispense/witness-approvals/{approvalId}/approve', {
    description:
      'Authenticates a second active PHARMACY_STAFF or PHARMACY_INCHARGE operator holding an ACTIVE grant for the exact order facility and approves the unchanged server-derived allocation. Self-witness, grant drift, expiry, replay, and payload drift fail closed. Final order dispense revalidates and consumes the approval atomically with stock and statutory register writes. Idempotency-Key is required.',
    pathParameters: {
      id: pharmacyOrderIdPathSchema,
      approvalId: pharmacyFacilityBoundApprovalIdPathSchema,
    },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderControlledWitnessDecisionRequest',
    response: 'PharmacyOrderControlledWitnessResponse',
    additionalResponses: {
      ...pharmacyOrderIdempotentErrorResponses,
      429: pharmacyOrderDispenseErrorResponse(
        'The witness credential attempt was rate limited or locked.',
      ),
    },
  }],
  ['GET /orders/{id}/delivery-assignees', {
    description:
      'Lists the couriers eligible to carry this order: active DELIVERY_STAFF identities holding a current unrevoked grant on the order\'s own pharmacy facility, with the grant authority version the dispatch caller must pin. Never invents an assignee for an order whose facility cannot be resolved.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    response: 'PharmacyDeliveryAssigneeResponse',
    additionalResponses: pharmacyOrderLifecycleErrorResponses,
  }],
  ['GET /orders/assigned', {
    description:
      'Lists only the authenticated delivery staff member\'s unconsumed in-transit or return-pending pharmacy packages under a current active facility grant. Handoff secrets are never returned.',
    response: 'PharmacyAssignedDeliveryResponse',
  }],
  ['POST /dispense', {
    description:
      'Dispenses a pharmacy order identified by the request body. Idempotency-Key is required and shared with the equivalent order-scoped counter-dispense aliases.',
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyBodyCounterDispenseRequest',
    response: 'PharmacyCounterDispenseResponse',
    additionalResponses: pharmacyOrderDispenseErrorResponses,
  }],
  ['POST /orders/{id}/delivered', {
    description:
      'The assigned facility-granted courier consumes the patient one-time handoff token against the exact pre-funded, pre-issued package. Pharmacy in-charge use is break-glass and requires a reason. Idempotency-Key is required.',
    parameters: [substitutionIdempotencyKeyParameter],
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyOrderDeliveryRequest',
    response: 'PharmacyOrderDeliveryResponse',
    additionalResponses: pharmacyOrderDispenseErrorResponses,
  }],
  ['POST /orders/{id}/delivery-handoff/reissue', {
    description:
      'A facility-granted pharmacy in-charge rotates the one-time patient handoff token and may reassign the package to another active facility-granted courier. Delivered and return-pending custody cannot be reopened. Idempotency-Key is required.',
    parameters: [substitutionIdempotencyKeyParameter],
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyDeliveryHandoffReissueRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/delivery-return/request', {
    description:
      'The assigned facility-granted courier or pharmacy in-charge moves an in-transit package to return-pending custody and durably notifies the named facility return owners. Idempotency-Key is required.',
    parameters: [substitutionIdempotencyKeyParameter],
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyDeliveryReturnRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/delivery-return/complete', {
    description:
      'A facility-granted pharmacy in-charge receives a return-pending sealed package and closes it as returned or quarantined. Issued stock is not silently restocked and any replacement requires new order authority. Idempotency-Key is required.',
    parameters: [substitutionIdempotencyKeyParameter],
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyDeliveryReturnCompletionRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/dispense-counter', {
    description:
      'Completes counter dispense only after the order remainder is allocated from exact Inventory V2 batches. Idempotency-Key is required and shared with the equivalent dispense aliases.',
    parameters: [substitutionIdempotencyKeyParameter],
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyCounterDispenseRequest',
    response: 'PharmacyCounterDispenseResponse',
    additionalResponses: pharmacyOrderDispenseErrorResponses,
  }],
  ['POST /orders/{id}/dispense', {
    description:
      'Alias for counter dispense. Idempotency-Key is required and shared with the equivalent counter-dispense aliases.',
    parameters: [substitutionIdempotencyKeyParameter],
    pathParameters: { id: pharmacyOrderIdPathSchema },
    request: 'PharmacyCounterDispenseRequest',
    response: 'PharmacyCounterDispenseResponse',
    additionalResponses: pharmacyOrderDispenseErrorResponses,
  }],
  ['POST /orders/{id}/unavailable', {
    description:
      'Closes an otherwise open order as UNAVAILABLE while preserving any already-dispensed partial inventory and cap custody.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderUnavailableRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /orders/{id}/cancel', {
    description:
      'Cancels an open order while preserving any already-dispensed partial inventory and cap custody.',
    pathParameters: { id: pharmacyOrderIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyOrderCancelRequest',
    response: 'PharmacyOrderMutationResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['GET /orders/uid/{uid}', {
    pathParameters: { uid: patientUidPathSchema },
  }],
  ['POST /dispense-substitution', {
    description:
      'Pharmacist dispenses an in-stock, same-formulation alternative for a prescribed brand. Both catalog ids are server-resolved and the swap re-checked for equivalence; the chosen batch is locked, validated and decremented atomically with the canonical clinical timeline + audit pair. Controlled substitutes (Schedule H/H1/X or narcotic inventory items) route through the witnessed statutory-register controlled-dispense path in the same transaction; Schedule X / narcotic substitutes additionally require an approved one-time witness_approval_id and fail closed without it. Idempotency-Key is required.',
    request: 'PharmacyDispenseSubstitutionRequest',
    response: 'PharmacyDispenseSubstitutionResponse',
    security: substitutionBearerSecurity,
    parameters: [substitutionIdempotencyKeyParameter],
    additionalResponses: substitutionWitnessErrorResponses({ idempotent: true }),
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
const SUPPLY_PREFIXES = ['/api/v1/admin/pharmacy-supply', '/api/v1/pharmacy-supply'];
const PRESCRIPTION_PREFIXES = ['/api/v1/prescriptions'];
const PRESCRIPTION_PHARMACY_OPS = [
  ['POST /{id}/order-pharmacy', {
    description:
      'Atomically creates and links the first pharmacy order from an exact tenant-scoped prescription. Every line must resolve to an authoritative catalog identity and current catalog price. Idempotency-Key is required.',
    pathParameters: { id: prescriptionIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyPrescriptionOrderRequest',
    requestRequired: false,
    response: 'PharmacyPrescriptionOrderResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /{id}/refill', {
    description:
      'Atomically creates and links a refill only after the prior prescription fulfilment is complete. Catalog identity and price are revalidated under lock. Idempotency-Key is required.',
    pathParameters: { id: prescriptionIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyPrescriptionOrderRequest',
    requestRequired: false,
    response: 'PharmacyPrescriptionOrderResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
  ['POST /{id}/amend-rejected-pharmacy-order', {
    description:
      'Atomically amends exactly one pharmacy-linked ON_HOLD/rejected prescription and its server-derived catalog projection. The original prescriber, or an active same-tenant CMO/MEDICAL_SUPERINTENDENT with an explicit clinical reason and locked patient-specific care-team or break-glass authority, re-signs the successor revision. Rejection evidence remains immutable; advancing the inventory-authority version makes fresh pharmacist verification mandatory. Idempotency-Key is required.',
    pathParameters: { id: prescriptionIdPathSchema },
    parameters: [substitutionIdempotencyKeyParameter],
    request: 'PharmacyRejectedPrescriptionAmendmentRequest',
    response: 'PharmacyRejectedPrescriptionAmendmentResponse',
    additionalResponses: pharmacyOrderIdempotentErrorResponses,
  }],
];
const SUPPLY_MOVEMENT_OPS = [
  ['POST /stock-movements', {
    description:
      'Appends a validated Inventory V2 stock movement and atomically projects the exact locked batch balance. Idempotency-Key is required and canonical across both route aliases.',
    security: substitutionBearerSecurity,
    responseStatus: 201,
    request: 'PharmacySupplyStockMovementRequest',
    response: 'PharmacySupplyStockMovementResponse',
    parameters: [substitutionIdempotencyKeyParameter],
    additionalResponses: {
      400: supplyStockMovementErrorResponse(
        'The stock movement or required Idempotency-Key is invalid.',
      ),
      409: supplyStockMovementErrorResponse(
        'The command is already in flight or the locked inventory evidence conflicts.',
      ),
      422: supplyStockMovementErrorResponse(
        'The Idempotency-Key was reused with a different stock-movement body.',
      ),
      503: supplyStockMovementErrorResponse(
        'The idempotency store is unavailable, so the stock movement failed closed.',
      ),
    },
  }],
  ['PATCH /goods-receipts/{id}/items/{itemId}/qc', {
    description:
      'Records one immutable passed/failed QC decision for an exact quarantined GRN line and storage location. Passed stock becomes usable; failed stock remains quarantined.',
    security: substitutionBearerSecurity,
    pathParameters: {
      id: positiveInt32,
      itemId: positiveInt32,
    },
    request: 'PharmacySupplyGoodsReceiptLineQcRequest',
    response: 'PharmacySupplyGoodsReceiptLineQcResponse',
    additionalResponses: {
      400: supplyStockMovementErrorResponse('The QC decision or receipt-line identity is invalid.'),
      403: supplyStockMovementErrorResponse('The actor lacks an active grant for the stored facility.'),
      409: supplyStockMovementErrorResponse('The receipt authority, quarantine state, or immutable QC decision conflicts.'),
    },
  }],
  ['PATCH /goods-receipts/{id}/transition', {
    description:
      'Applies a governed one-way GRN lifecycle action: reject before lines, finalize after all QC decisions, close accepted stock, or archive a closed/wholly-failed receipt.',
    security: substitutionBearerSecurity,
    pathParameters: { id: positiveInt32 },
    request: 'PharmacySupplyGoodsReceiptTransitionRequest',
    response: 'PharmacySupplyGoodsReceiptTransitionResponse',
    additionalResponses: {
      400: supplyStockMovementErrorResponse('The lifecycle action or goods receipt identity is invalid.'),
      403: supplyStockMovementErrorResponse('The actor lacks an active grant for the stored facility.'),
      409: supplyStockMovementErrorResponse('The goods receipt is not eligible for the requested one-way transition.'),
    },
  }],
];

/** Fan each [«METHOD /suffix», overlay] out to the given mount prefixes. */
function aliasOps(pairs, prefixes = PREFIXES) {
  const out = {};
  for (const [methodSuffix, ov] of pairs) {
    const spaceIdx = methodSuffix.indexOf(' ');
    const method = methodSuffix.slice(0, spaceIdx);
    const suffix = methodSuffix.slice(spaceIdx + 1);
    for (const pre of prefixes) {
      out[`${method} ${pre}${suffix}`] = {
        ...ov,
        security: ov.security ?? substitutionBearerSecurity,
      };
    }
  }
  return out;
}

export const operations = {
  ...aliasOps(OPS),
  ...aliasOps(SUPPLY_MOVEMENT_OPS, SUPPLY_PREFIXES),
  ...aliasOps(PRESCRIPTION_PHARMACY_OPS, PRESCRIPTION_PREFIXES),
};
