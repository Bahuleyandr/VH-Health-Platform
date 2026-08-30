// apps/backend/scripts/openapi/schemas/pharmacyCounterSale.mjs
// Walk-in pharmacy point-of-sale (migration 684), served from
// /api/v1/pharmacy-orders/counter-sales/* (and the /api/v1/pharmacy alias).
// FEFO batch dispensing + schedule-class enforcement + billingV2 PHARMACY
// invoice with pay-at-counter, tied to the cashier's open cash-drawer session.
import { envelope, listEnvelope } from './_helpers.mjs';

const witnessErrorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PharmacyControlledDispenseWitnessErrorResponse' }
    }
  }
});

const witnessErrorResponses = ({ idempotent = false } = {}) => ({
  400: witnessErrorResponse(
    'The dispense payload, witness identity, or credential pair was invalid.'
  ),
  401: witnessErrorResponse('The independently supplied witness credentials were invalid.'),
  403: witnessErrorResponse('The authenticated caller or witness tenant/role was not permitted.'),
  404: witnessErrorResponse('The inventory item or witness approval was not found in this tenant.'),
  409: witnessErrorResponse(
    'The approval expired, was consumed, or did not match the unchanged dispense.'
  ),
  429: witnessErrorResponse('The witness credential attempt was rate limited or locked.'),
  500: witnessErrorResponse('The controlled-dispense approval could not be completed.'),
  ...(idempotent
    ? {
        422: witnessErrorResponse('The Idempotency-Key was reused with a different request body.'),
        503: witnessErrorResponse(
          'The idempotency store was unavailable, so the mutation failed closed.'
        )
      }
    : {})
});

const bearerSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];
// Same idiom as scripts/openapi/schemas/pharmacy.mjs — facilities are int4.
const positiveInt32 = { type: 'integer', minimum: 1, maximum: 2147483647 };
const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Stable key for this logical mutation. Retries with the unchanged body replay the durable original result.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$'
  }
};
const positiveSignedInt64IdSchema = (description =
  'Canonical positive signed 64-bit decimal string (1..9223372036854775807).') => ({
  type: 'string',
  pattern: '^[1-9][0-9]{0,18}$',
  minLength: 1,
  maxLength: 19,
  'x-maximum': '9223372036854775807',
  description
});
const approvalIdPathSchema = positiveSignedInt64IdSchema();
const CLINICAL_CONTROLLED_WITNESS_ROLES = [
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  'DOCTOR',
  'DUTY_DOCTOR',
  'MEDICAL_SUPERINTENDENT',
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'OP_STAFF_NURSE',
  'OP_INCHARGE'
];
const FACILITY_BOUND_CONTROLLED_WITNESS_ROLES = [
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE'
];
const CLINICAL_CONTROLLED_WITNESS_SCOPES = [
  'pharmacy_counter_sale',
  'pharmacy_dispense_substitution',
  'ward_indent_controlled_handoff'
];
const controlledWitnessApprovalSchema = ({ scopes, payloadSchema, witnessSchema }) => {
  const publicProperties = {
    id: positiveSignedInt64IdSchema('Canonical witness approval id serialized as text.'),
    contract: { type: 'string', enum: ['controlled_dispense_witness_v1'] },
    scope: { type: 'string', enum: scopes },
    requested_by: { type: 'string', format: 'uuid' },
    payload: payloadSchema,
    payload_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    expires_at: { type: 'string', format: 'date-time' }
  };
  const required = [
    'id',
    'contract',
    'scope',
    'status',
    'requested_by',
    'payload',
    'payload_fingerprint',
    'expires_at'
  ];
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required,
        properties: {
          ...publicProperties,
          status: { type: 'string', enum: ['pending'] }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [...required, 'witness'],
        properties: {
          ...publicProperties,
          status: { type: 'string', enum: ['approved'] },
          witness: witnessSchema
        }
      }
    ]
  };
};

const counterSaleIntentProperties = {
  facility_id: {
    ...positiveInt32,
    description:
      'Exact dispensing facility for this sale. It is a REQUEST, not authority: the server proves the authenticated seller holds an ACTIVE pharmacy grant for it before any stock, price, or custody evidence is read or written, and rejects the sale otherwise.'
  },
  lines: {
    type: 'array',
    minItems: 1,
    items: { $ref: '#/components/schemas/PharmacyCounterSaleLineInput' }
  },
  patient_uid: {
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Registered patient. Omit for an anonymous walk-in (customer_name then required).'
  },
  customer_name: { type: 'string', nullable: true },
  customer_phone: { type: 'string', nullable: true },
  rx: { allOf: [{ $ref: '#/components/schemas/PharmacyCounterSaleRxInput' }], nullable: true },
  payment_mode: {
    type: 'string',
    enum: ['CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET']
  },
  payment_reference: {
    type: 'string',
    nullable: true,
    minLength: 1,
    maxLength: 200,
    pattern: '^[^\\u0000-\\u001F\\u007F]+$',
    description:
      'Original external receipt, instrument, or provider reference. Required for CARD, UPI, NETBANKING, CHEQUE, DD, and WALLET so any later refund can bind to the original payment; optional for CASH.'
  },
  notes: { type: 'string', nullable: true }
};

const counterSalePaymentReferenceOneOf = [
  {
    title: 'Cash sale',
    properties: { payment_mode: { type: 'string', enum: ['CASH'] } }
  },
  {
    title: 'Externally referenced sale',
    required: ['payment_reference'],
    properties: {
      payment_mode: {
        type: 'string',
        enum: ['CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET']
      },
      payment_reference: {
        type: 'string',
        nullable: false,
        minLength: 1,
        maxLength: 200,
        pattern: '^[^\\u0000-\\u001F\\u007F]+$'
      }
    }
  }
];

const inventoryDisposalIntentProperties = {
  facility_id: {
    ...positiveInt32,
    description:
      'Exact facility that holds the batch. This identifies the requested custody scope; the server separately proves the authenticated operator has an ACTIVE facility grant and never accepts caller-supplied grant authority.'
  },
  inventory_item_id: { type: 'integer', minimum: 1, maximum: 2147483647 },
  inventory_batch_id: { type: 'integer', minimum: 1, maximum: 2147483647 },
  quantity: {
    type: 'number',
    minimum: 0.0001,
    maximum: 9999999999.9999,
    multipleOf: 0.0001,
    description: 'Positive NUMERIC(14,4) disposal quantity.'
  },
  reason_code: {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    description: 'Governed disposal reason code, for example damaged.'
  },
  disposition_method: {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    description: 'Recorded physical disposition method, for example authorized_incineration.'
  },
  authority_reference: {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    nullable: true,
    description: 'Optional external disposal authorization or manifest reference.'
  },
  expected_batch_number: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
  expected_lot_number: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
  expected_expiry_date: { type: 'string', format: 'date', nullable: true },
  notes: { type: 'string', minLength: 1, maxLength: 2000, nullable: true }
};

const inventoryDisposalRequiredFields = [
  'facility_id',
  'inventory_item_id',
  'inventory_batch_id',
  'quantity',
  'reason_code',
  'disposition_method'
];

export const schemas = {
  PharmacyCounterSaleLineInput: {
    type: 'object',
    required: ['inventory_item_id', 'quantity'],
    properties: {
      inventory_item_id: { type: 'integer' },
      quantity: { type: 'number', minimum: 0.0001 },
      prescription_line_index: {
        type: 'integer',
        minimum: 0,
        nullable: true,
        description:
          'Zero-based line on the signed e-prescription this controlled line dispenses against. Required for every Schedule H/H1/X or narcotic line. A line carries no prescription_id of its own: the prescription is the sale-level rx.prescription_id, and the server stamps that anchor alongside this index on the stored line. Sending an index without rx.prescription_id is rejected.'
      }
    }
  },

  PharmacyCounterSaleRxInput: {
    type: 'object',
    description:
      'Signed e-prescription anchor — REQUIRED, together with a registered patient_uid and an exact prescription_line_index on every controlled line, when any line is Schedule H/H1/X or narcotic. Free-text prescriber fields are recorded as paper-trail snapshots only and never satisfy the schedule gate.',
    properties: {
      prescription_id: {
        ...positiveInt32,
        nullable: true,
        description:
          'Exact signed e-prescription this sale dispenses against. This is the only accepted prescription authority for a controlled line.'
      },
      doctor_name: {
        type: 'string',
        nullable: true,
        description: 'Non-authoritative prescriber snapshot kept on the sale header.'
      },
      reference: {
        type: 'string',
        nullable: true,
        description: 'Non-authoritative Rx number / free reference kept on the sale header.'
      },
      upload_id: {
        type: 'integer',
        nullable: true,
        description: 'Pointer into the tenant upload store (e.g. a photographed paper Rx).'
      },
      id_proof_type: { type: 'string', nullable: true },
      id_proof_last4: { type: 'string', nullable: true }
    }
  },

  PharmacyCounterSaleFacilityGrant: {
    type: 'object',
    required: ['facility_id'],
    properties: {
      facility_id: positiveInt32,
      facility_code: { type: 'string', nullable: true },
      display_name: { type: 'string', nullable: true },
      grant_id: {
        type: 'string',
        pattern: '^[1-9][0-9]*$',
        description: 'Canonical pharmacy_staff_facility_grants id serialized as text.'
      },
      authority_version: { type: 'integer' }
    }
  },

  PharmacyCounterSaleFacilityGrantList: {
    type: 'object',
    required: ['facilities'],
    properties: {
      facilities: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSaleFacilityGrant' }
      }
    }
  },

  PharmacyCounterSaleCreateRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['facility_id', 'lines', 'payment_mode'],
    oneOf: counterSalePaymentReferenceOneOf,
    properties: {
      ...counterSaleIntentProperties,
      witness_approval_id: {
        type: 'string',
        pattern: '^[1-9][0-9]*$',
        nullable: true,
        description:
          'Approved, unexpired one-time witness approval returned by the two-person approval flow. Required for Schedule X / narcotic lines; caller-selected witness identity is never accepted.'
      }
    }
  },

  PharmacyCounterSaleWitnessApprovalRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['facility_id', 'lines', 'payment_mode'],
    oneOf: counterSalePaymentReferenceOneOf,
    properties: { ...counterSaleIntentProperties },
    description:
      'The exact prospective sale payload to bind to a short-lived pending witness approval. witness_approval_id is not accepted on this pre-approval request.'
  },

  PharmacyCounterSaleWitnessApprovalDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['sale'],
    properties: {
      sale: {
        $ref: '#/components/schemas/PharmacyCounterSaleWitnessApprovalRequest'
      },
      employeeId: {
        type: 'string',
        pattern: '^[A-Z0-9-]{3,20}$',
        description:
          'Witness employee ID for an in-session password step-up. Must be supplied with password; the server derives the witness UID from this authentication.'
      },
      password: {
        type: 'string',
        format: 'password',
        minLength: 6,
        maxLength: 100,
        writeOnly: true,
        description:
          'Witness password for the one-request step-up. It is neither returned nor persisted and does not replace the seller session.'
      }
    },
    oneOf: [
      { required: ['employeeId', 'password'] },
      {
        not: {
          anyOf: [{ required: ['employeeId'] }, { required: ['password'] }]
        }
      }
    ]
  },

  PharmacyClinicalControlledWitnessIdentity: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'name', 'role'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1 },
      role: { type: 'string', enum: CLINICAL_CONTROLLED_WITNESS_ROLES }
    }
  },

  PharmacyFacilityBoundControlledWitnessIdentity: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'name', 'role', 'facility_grant_id'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1 },
      role: { type: 'string', enum: FACILITY_BOUND_CONTROLLED_WITNESS_ROLES },
      facility_grant_id: positiveSignedInt64IdSchema(
        'ACTIVE pharmacy_staff_facility_grants id for this witness and exact facility.'
      )
    }
  },

  PharmacyCounterSaleWitnessApproval: controlledWitnessApprovalSchema({
    scopes: CLINICAL_CONTROLLED_WITNESS_SCOPES,
    payloadSchema: { type: 'object', additionalProperties: true },
    witnessSchema: {
      $ref: '#/components/schemas/PharmacyClinicalControlledWitnessIdentity'
    }
  }),

  PharmacyInventoryDisposalWitnessPayload: {
    type: 'object',
    additionalProperties: false,
    required: [
      'contract',
      'facility_id',
      'facility_grant_id',
      'performer_role',
      'inventory_item_id',
      'inventory_batch_id',
      'catalog_id',
      'supplier_id',
      'storage_location_id',
      'batch_number',
      'lot_number',
      'expiry_date',
      'source_batch_status',
      'quantity',
      'reason_code',
      'disposition_method',
      'authority_reference',
      'notes'
    ],
    properties: {
      contract: { type: 'string', enum: ['pharmacy_inventory_disposal_v1'] },
      facility_id: positiveInt32,
      facility_grant_id: positiveSignedInt64IdSchema(
        'ACTIVE facility grant of the authenticated disposal operator.'
      ),
      performer_role: {
        type: 'string',
        enum: FACILITY_BOUND_CONTROLLED_WITNESS_ROLES
      },
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      catalog_id: positiveInt32,
      supplier_id: positiveInt32,
      storage_location_id: positiveInt32,
      batch_number: { type: 'string', minLength: 1, maxLength: 120 },
      lot_number: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
      expiry_date: { type: 'string', format: 'date' },
      source_batch_status: {
        type: 'string',
        enum: ['in_stock', 'expired', 'recalled', 'quarantined']
      },
      quantity: inventoryDisposalIntentProperties.quantity,
      reason_code: inventoryDisposalIntentProperties.reason_code,
      disposition_method: inventoryDisposalIntentProperties.disposition_method,
      authority_reference: inventoryDisposalIntentProperties.authority_reference,
      notes: inventoryDisposalIntentProperties.notes
    }
  },

  PharmacyInventoryDisposalWitnessApproval: controlledWitnessApprovalSchema({
    scopes: ['pharmacy_inventory_controlled_disposal'],
    payloadSchema: {
      $ref: '#/components/schemas/PharmacyInventoryDisposalWitnessPayload'
    },
    witnessSchema: {
      $ref: '#/components/schemas/PharmacyFacilityBoundControlledWitnessIdentity'
    }
  }),

  PharmacyInventoryDisposalWitnessApprovalRequest: {
    type: 'object',
    additionalProperties: false,
    required: inventoryDisposalRequiredFields,
    properties: { ...inventoryDisposalIntentProperties },
    description:
      'Exact prospective batch disposal bound to a short-lived approval. Caller-selected witness identity, movement kind, performer, facility grant authority, and witness approval id are not accepted.'
  },

  PharmacyInventoryDisposalWitnessApprovalDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['disposal'],
    properties: {
      disposal: {
        $ref: '#/components/schemas/PharmacyInventoryDisposalWitnessApprovalRequest'
      },
      employeeId: {
        type: 'string',
        pattern: '^[A-Z0-9-]{3,20}$',
        description:
          'Employee ID of the second active pharmacy operator holding an ACTIVE grant for the exact disposal facility. Supply with password; otherwise the authenticated bearer is used.'
      },
      password: {
        type: 'string',
        format: 'password',
        minLength: 6,
        maxLength: 100,
        writeOnly: true,
        description:
          'Witness password for the one-request step-up. It is excluded from idempotency projection and is never returned or persisted.'
      }
    },
    oneOf: [
      { required: ['employeeId', 'password'] },
      {
        not: {
          anyOf: [{ required: ['employeeId'] }, { required: ['password'] }]
        }
      }
    ]
  },

  PharmacyInventoryDisposalRequest: {
    type: 'object',
    additionalProperties: false,
    required: inventoryDisposalRequiredFields,
    properties: {
      ...inventoryDisposalIntentProperties,
      witness_approval_id: {
        ...positiveSignedInt64IdSchema(
          'Approved, unexpired one-time approval bound to this exact disposal.'
        ),
        nullable: true
      }
    },
    description:
      'One typed batch-disposal command. Movement kind, performer, witness identity, and facility authority are server-derived. Schedule X or narcotic stock requires an independently approved one-time witness approval.'
  },

  PharmacyInventoryDisposalEvidence: {
    type: 'object',
    additionalProperties: false,
    required: [
      'contract',
      'facility_id',
      'inventory_item_id',
      'inventory_batch_id',
      'quantity',
      'reason_code',
      'disposition_method',
      'authority_reference',
      'source_batch_status',
      'resulting_batch_status',
      'movement_id',
      'schedule_register_id',
      'witness_approval_id',
      'performed_by',
      'facility_grant_id',
      'witness_uid',
      'witness_facility_grant_id',
      'command_key_sha256',
      'request_sha256',
      'completed_at'
    ],
    properties: {
      contract: { type: 'string', enum: ['pharmacy_inventory_disposal_v1'] },
      facility_id: positiveInt32,
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      quantity: inventoryDisposalIntentProperties.quantity,
      reason_code: inventoryDisposalIntentProperties.reason_code,
      disposition_method: inventoryDisposalIntentProperties.disposition_method,
      authority_reference: inventoryDisposalIntentProperties.authority_reference,
      source_batch_status: {
        type: 'string',
        enum: ['in_stock', 'expired', 'recalled', 'quarantined']
      },
      resulting_batch_status: {
        type: 'string',
        enum: ['in_stock', 'expired', 'recalled', 'quarantined', 'disposed']
      },
      movement_id: positiveInt32,
      schedule_register_id: { ...positiveInt32, nullable: true },
      witness_approval_id: {
        ...positiveSignedInt64IdSchema(),
        nullable: true
      },
      performed_by: { type: 'string', format: 'uuid' },
      facility_grant_id: positiveSignedInt64IdSchema(
        'Canonical pharmacy facility-grant BIGINT id serialized as decimal text.'
      ),
      witness_uid: { type: 'string', format: 'uuid', nullable: true },
      witness_facility_grant_id: {
        ...positiveSignedInt64IdSchema(
          'Canonical witness facility-grant BIGINT id serialized as decimal text.'
        ),
        nullable: true
      },
      command_key_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      request_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      completed_at: { type: 'string', format: 'date-time' }
    }
  },

  PharmacyInventoryDisposalMovement: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'facility_id',
      'inventory_item_id',
      'inventory_batch_id',
      'movement_kind',
      'quantity_delta',
      'reference_type',
      'reference_id',
      'performed_by',
      'notes',
      'created_at'
    ],
    properties: {
      id: positiveInt32,
      facility_id: positiveInt32,
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      movement_kind: { type: 'string', enum: ['dispose'] },
      quantity_delta: {
        type: 'number',
        minimum: -9999999999.9999,
        maximum: -0.0001,
        multipleOf: 0.0001
      },
      reference_type: { type: 'string', enum: ['inventory_batch_disposal'] },
      reference_id: {
        type: 'string',
        pattern: '^[1-9][0-9]{0,9}$',
        minLength: 1,
        maxLength: 10,
        'x-maximum': '2147483647'
      },
      performed_by: { type: 'string', format: 'uuid' },
      notes: { type: 'string', minLength: 1 },
      created_at: { type: 'string', format: 'date-time' }
    }
  },

  PharmacyInventoryDisposalRegisterEntry: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'facility_id',
      'inventory_item_id',
      'inventory_batch_id',
      'schedule_class',
      'movement_kind',
      'quantity',
      'unit_label',
      'running_balance',
      'patient_uid',
      'patient_name',
      'patient_phone',
      'prescription_id',
      'prescription_number',
      'prescriber_uid',
      'prescriber_name',
      'prescriber_registration',
      'patient_id_proof_type',
      'patient_id_proof_last4',
      'performed_by',
      'performed_by_name',
      'witness_uid',
      'witness_name',
      'reference_movement_id',
      'notes',
      'created_at'
    ],
    properties: {
      id: positiveInt32,
      facility_id: positiveInt32,
      inventory_item_id: positiveInt32,
      inventory_batch_id: positiveInt32,
      schedule_class: { type: 'string', enum: ['H', 'H1', 'X'] },
      movement_kind: { type: 'string', enum: ['dispose'] },
      quantity: inventoryDisposalIntentProperties.quantity,
      unit_label: { type: 'string', minLength: 1, maxLength: 40, nullable: true },
      running_balance: {
        type: 'number',
        minimum: 0,
        maximum: 9999999999.9999,
        multipleOf: 0.0001
      },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_name: { type: 'string', maxLength: 255, nullable: true },
      patient_phone: { type: 'string', maxLength: 20, nullable: true },
      prescription_id: { ...positiveInt32, nullable: true },
      prescription_number: { type: 'string', maxLength: 80, nullable: true },
      prescriber_uid: { type: 'string', format: 'uuid', nullable: true },
      prescriber_name: { type: 'string', maxLength: 255, nullable: true },
      prescriber_registration: { type: 'string', maxLength: 80, nullable: true },
      patient_id_proof_type: { type: 'string', maxLength: 40, nullable: true },
      patient_id_proof_last4: { type: 'string', maxLength: 4, nullable: true },
      performed_by: { type: 'string', format: 'uuid' },
      performed_by_name: { type: 'string', minLength: 1, maxLength: 255 },
      witness_uid: { type: 'string', format: 'uuid', nullable: true },
      witness_name: { type: 'string', maxLength: 255, nullable: true },
      reference_movement_id: positiveInt32,
      notes: { type: 'string', minLength: 1 },
      created_at: { type: 'string', format: 'date-time' }
    }
  },

  PharmacyInventoryDisposalResult: {
    type: 'object',
    additionalProperties: false,
    required: ['disposal', 'movement', 'register_entry', 'idempotent_replay'],
    properties: {
      disposal: { $ref: '#/components/schemas/PharmacyInventoryDisposalEvidence' },
      movement: { $ref: '#/components/schemas/PharmacyInventoryDisposalMovement' },
      register_entry: {
        allOf: [{ $ref: '#/components/schemas/PharmacyInventoryDisposalRegisterEntry' }],
        nullable: true,
        description: 'Present for Schedule H, H1, X, or narcotic stock.'
      },
      idempotent_replay: { type: 'boolean' }
    }
  },

  PharmacyInventoryScheduleRegisterEntry: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'facility_id',
      'inventory_item_id',
      'inventory_batch_id',
      'created_at',
      'schedule_class',
      'movement_kind',
      'sku_code',
      'display_name',
      'generic_name',
      'brand_name',
      'strength',
      'form',
      'batch_number',
      'expiry_date',
      'quantity',
      'unit_label',
      'running_balance',
      'patient_uid',
      'patient_name',
      'patient_phone',
      'prescription_id',
      'prescription_number',
      'prescriber_uid',
      'prescriber_name',
      'prescriber_registration',
      'patient_id_proof_type',
      'patient_id_proof_last4',
      'performed_by',
      'performed_by_name',
      'witness_uid',
      'witness_name',
      'reference_movement_id',
      'notes'
    ],
    properties: {
      id: positiveInt32,
      facility_id: positiveInt32,
      inventory_item_id: positiveInt32,
      inventory_batch_id: { ...positiveInt32, nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      schedule_class: { type: 'string', enum: ['H', 'H1', 'X'] },
      movement_kind: { type: 'string', maxLength: 40 },
      sku_code: { type: 'string', maxLength: 120 },
      display_name: { type: 'string', maxLength: 255 },
      generic_name: { type: 'string', maxLength: 255, nullable: true },
      brand_name: { type: 'string', maxLength: 255, nullable: true },
      strength: { type: 'string', maxLength: 80, nullable: true },
      form: { type: 'string', maxLength: 80, nullable: true },
      batch_number: { type: 'string', maxLength: 120, nullable: true },
      expiry_date: { type: 'string', format: 'date', nullable: true },
      quantity: {
        type: 'number',
        minimum: 0.0001,
        maximum: 9999999999.9999,
        multipleOf: 0.0001
      },
      unit_label: { type: 'string', maxLength: 40, nullable: true },
      running_balance: {
        type: 'number',
        minimum: 0,
        maximum: 9999999999.9999,
        multipleOf: 0.0001
      },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_name: { type: 'string', maxLength: 255, nullable: true },
      patient_phone: { type: 'string', maxLength: 20, nullable: true },
      prescription_id: { ...positiveInt32, nullable: true },
      prescription_number: { type: 'string', maxLength: 80, nullable: true },
      prescriber_uid: { type: 'string', format: 'uuid', nullable: true },
      prescriber_name: { type: 'string', maxLength: 255, nullable: true },
      prescriber_registration: { type: 'string', maxLength: 80, nullable: true },
      patient_id_proof_type: { type: 'string', maxLength: 40, nullable: true },
      patient_id_proof_last4: { type: 'string', maxLength: 4, nullable: true },
      performed_by: { type: 'string', format: 'uuid' },
      performed_by_name: { type: 'string', maxLength: 255, nullable: true },
      witness_uid: { type: 'string', format: 'uuid', nullable: true },
      witness_name: { type: 'string', maxLength: 255, nullable: true },
      reference_movement_id: { ...positiveInt32, nullable: true },
      notes: { type: 'string', nullable: true }
    }
  },

  PharmacyInventoryGenericMovementRetiredResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message', 'code'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string', enum: ['INVENTORY_GENERIC_MOVEMENT_RETIRED'] },
      requestId: { type: 'string', nullable: true }
    }
  },

  PharmacyInventoryStandaloneControlledDispenseRetiredResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message', 'code'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: {
        type: 'string',
        enum: ['INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED']
      },
      requestId: { type: 'string', nullable: true }
    }
  },

  PharmacyControlledDispenseWitnessErrorResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string' },
      requestId: { type: 'string' },
      details: { type: 'object', additionalProperties: true }
    }
  },

  PharmacyCounterSaleAllocation: {
    type: 'object',
    properties: {
      id: positiveSignedInt64IdSchema('Canonical allocation BIGSERIAL id serialized as text.'),
      inventory_batch_id: { type: 'integer' },
      batch_number: { type: 'string' },
      expiry_date: { type: 'string', format: 'date' },
      quantity: { type: 'number' },
      unit_price: { type: 'number' },
      movement_id: {
        type: 'integer',
        description: 'The pharmacy_stock_movements issue row this allocation committed with.'
      },
      return_movement_id: {
        type: 'integer',
        nullable: true,
        description: 'Set once a void restocked this allocation.'
      }
    }
  },

  PharmacyCounterSaleLine: {
    type: 'object',
    properties: {
      id: positiveSignedInt64IdSchema('Canonical counter-sale line BIGSERIAL id serialized as text.'),
      inventory_item_id: { type: 'integer' },
      item_name: { type: 'string' },
      schedule_class: { type: 'string', nullable: true, enum: ['H', 'H1', 'X', 'OTC', null] },
      is_narcotic: { type: 'boolean' },
      quantity: { type: 'number' },
      unit_price: { type: 'number' },
      gst_rate: { type: 'number' },
      line_total: { type: 'number' },
      allocations: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSaleAllocation' }
      }
    }
  },

  PharmacyCounterSale: {
    type: 'object',
    properties: {
      id: positiveSignedInt64IdSchema('Canonical counter-sale BIGSERIAL id serialized as text.'),
      tenant_id: { type: 'string', format: 'uuid' },
      facility_id: {
        ...positiveInt32,
        description:
          'Facility that owns this sale. Reads are scoped to it: a by-id read resolves this value from the stored row and proves the caller holds an active grant on THAT facility.'
      },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      customer_name: { type: 'string', nullable: true },
      customer_phone: { type: 'string', nullable: true },
      rx_doctor_name: { type: 'string', nullable: true },
      rx_reference: { type: 'string', nullable: true },
      rx_upload_id: { type: 'integer', nullable: true },
      status: {
        type: 'string',
        enum: ['IN_PROGRESS', 'COMPLETED', 'VOID_PENDING_REFUND', 'VOIDED', 'FAILED']
      },
      invoice_id: { type: 'integer', nullable: true },
      invoice_number: { type: 'string', nullable: true },
      payment_mode: { type: 'string', nullable: true },
      payment_reference: { type: 'string', nullable: true },
      cash_shift: { type: 'string', nullable: true },
      total_amount: { type: 'number' },
      sold_by: { type: 'string', format: 'uuid' },
      sold_by_name: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      voided_at: { type: 'string', format: 'date-time', nullable: true },
      voided_by: { type: 'string', format: 'uuid', nullable: true },
      void_reason: { type: 'string', nullable: true },
      void_refund_id: { type: 'integer', nullable: true },
      void_request_id: {
        ...positiveSignedInt64IdSchema(
          'Latest durable canonical counter-sale void request id.'
        ),
        nullable: true
      },
      void_request_status: {
        type: 'string',
        nullable: true,
        enum: [
          'CREATING',
          'PENDING_REFUND',
          'REFUND_REJECTED_REVIEW',
          'CANCELLED_HANDOVER_CONFIRMED',
          'COMPLETED',
          null
        ]
      },
      void_refund_status: {
        type: 'string',
        nullable: true,
        enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAID', null]
      },
      void_readiness: {
        type: 'string',
        enum: [
          'READY',
          'ORIGINAL_PAYMENT_REFERENCE_MISSING',
          'OUTSIDE_SAME_DAY_WINDOW',
          'PENDING_REFUND',
          'VOIDED',
          'NOT_COMPLETED'
        ],
        description:
          'Server-derived readiness. Legacy non-cash sales without an original payment reference remain fail-closed and are never given fabricated refund evidence.'
      },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      lines: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSaleLine' }
      }
    }
  },

  PharmacyCounterSaleCreateResult: {
    type: 'object',
    required: ['sale'],
    properties: {
      sale: { $ref: '#/components/schemas/PharmacyCounterSale' },
      invoice: {
        type: 'object',
        description: 'The billingV2 PHARMACY invoice (issued + paid) backing the sale.'
      },
      payment: {
        type: 'object',
        description: 'The billing_payments row collected at the counter.'
      }
    }
  },

  PharmacyCounterSaleVoidRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'disposition'],
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 255 },
      disposition: {
        type: 'string',
        enum: ['NEVER_HANDED_OVER'],
        description:
          'Only never-handed-over medicine can use this restock path. Patient-returned medicine fails closed and must enter the governed return/quarantine workflow.'
      }
    }
  },

  PharmacyCounterSaleVoidRejectionResolutionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['resolution', 'reason'],
    properties: {
      resolution: { type: 'string', enum: ['CUSTOMER_HANDOVER_CONFIRMED'] },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'Auditable explanation confirming that custody remained with the customer after finance rejected the refund. No stock return is performed.'
      }
    }
  },

  PharmacyCounterSaleVoidTask: {
    type: 'object',
    required: [
      'id', 'counter_sale_id', 'invoice_id', 'refund_id', 'amount', 'refund_mode',
      'disposition', 'reason', 'status', 'task_stage', 'requested_at'
    ],
    properties: {
      id: positiveSignedInt64IdSchema('Canonical counter-sale void request id.'),
      counter_sale_id: positiveSignedInt64IdSchema('Canonical counter-sale id.'),
      invoice_id: { type: 'integer' },
      refund_id: { type: 'integer' },
      amount: { type: 'number', minimum: 0.01 },
      refund_mode: {
        type: 'string',
        enum: ['CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET']
      },
      disposition: { type: 'string', enum: ['NEVER_HANDED_OVER'] },
      reason: { type: 'string' },
      status: {
        type: 'string',
        enum: [
          'PENDING_REFUND',
          'REFUND_REJECTED_REVIEW',
          'CANCELLED_HANDOVER_CONFIRMED',
          'COMPLETED'
        ]
      },
      task_stage: {
        type: 'string',
        enum: ['approval', 'payout', 'reconciliation', 'rejected_review', 'completed', 'cancelled']
      },
      task_id: { type: 'integer', nullable: true },
      task_status: { type: 'string', nullable: true },
      task_due_at: { type: 'string', format: 'date-time', nullable: true },
      workflow_sla_instance_id: { type: 'string', format: 'uuid', nullable: true },
      requested_at: { type: 'string', format: 'date-time' },
      last_checked_at: { type: 'string', format: 'date-time', nullable: true },
      reconciled_at: { type: 'string', format: 'date-time', nullable: true },
      reconciliation_source: { type: 'string', enum: ['manual', 'system'], nullable: true }
    }
  },

  PharmacyCounterSaleVoidRefund: {
    type: 'object',
    required: ['id', 'invoice_id', 'patient_uid', 'amount', 'mode', 'approval_status'],
    properties: {
      id: { type: 'integer' },
      invoice_id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      amount: { type: 'number', minimum: 0.01 },
      mode: {
        type: 'string',
        enum: ['CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET']
      },
      approval_status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAID'] },
      payout_rail: {
        type: 'string',
        enum: ['manual', 'gateway', 'offline_electronic'],
        nullable: true
      },
      reference: { type: 'string', nullable: true },
      raised_at: { type: 'string', format: 'date-time', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      paid_at: { type: 'string', format: 'date-time', nullable: true },
      gateway_execution_status: { type: 'string', nullable: true }
    }
  },

  PharmacyCounterSaleVoidAction: {
    type: 'object',
    required: ['action_key', 'deep_link', 'resource_type', 'resource_id'],
    properties: {
      action_key: { type: 'string' },
      deep_link: {
        type: 'string',
        description:
          'Strict local Staff navigation target carrying positive resource identifiers; it is not a raw API path.'
      },
      resource_type: { type: 'string' },
      resource_id: {
        oneOf: [
          { type: 'integer' },
          positiveSignedInt64IdSchema('Canonical counter-sale resource id.')
        ]
      },
      invoice_id: { type: 'integer', nullable: true },
      counter_sale_void_request_id: positiveSignedInt64IdSchema(
        'Canonical counter-sale void request id.'
      )
    }
  },

  PharmacyCounterSaleVoidActions: {
    type: 'object',
    required: ['finance_review', 'pharmacy_reconciliation'],
    properties: {
      finance_review: { $ref: '#/components/schemas/PharmacyCounterSaleVoidAction' },
      pharmacy_reconciliation: { $ref: '#/components/schemas/PharmacyCounterSaleVoidAction' }
    }
  },

  PharmacyCounterSaleVoidResult: {
    type: 'object',
    required: ['outcome', 'workflow_status', 'sale', 'void_request', 'refund', 'actions'],
    properties: {
      outcome: {
        type: 'string',
        enum: [
          'pending_refund', 'refund_rejected_review', 'voided', 'handover_confirmed', 'replay'
        ]
      },
      workflow_status: {
        type: 'string',
        enum: [
          'NOT_REQUESTED',
          'AWAITING_FINANCE_APPROVAL',
          'AWAITING_FINANCE_PAYOUT',
          'AWAITING_GATEWAY_PAYOUT',
          'AWAITING_GATEWAY_EVIDENCE',
          'AWAITING_PAYOUT_EVIDENCE',
          'READY_TO_RECONCILE',
          'REFUND_REJECTED_REVIEW',
          'VOIDED',
          'CANCELLED_HANDOVER_CONFIRMED',
          'PENDING_REVIEW'
        ]
      },
      sale: { $ref: '#/components/schemas/PharmacyCounterSale' },
      void_request: { $ref: '#/components/schemas/PharmacyCounterSaleVoidTask' },
      refund: { $ref: '#/components/schemas/PharmacyCounterSaleVoidRefund' },
      actions: { $ref: '#/components/schemas/PharmacyCounterSaleVoidActions' }
    }
  },

  PharmacyCounterSaleVoidStatusResult: {
    type: 'object',
    required: ['workflow_status', 'sale', 'void_request', 'refund', 'actions'],
    properties: {
      workflow_status: {
        type: 'string',
        enum: [
          'NOT_REQUESTED',
          'AWAITING_FINANCE_APPROVAL',
          'AWAITING_FINANCE_PAYOUT',
          'AWAITING_GATEWAY_PAYOUT',
          'AWAITING_GATEWAY_EVIDENCE',
          'AWAITING_PAYOUT_EVIDENCE',
          'READY_TO_RECONCILE',
          'REFUND_REJECTED_REVIEW',
          'VOIDED',
          'CANCELLED_HANDOVER_CONFIRMED',
          'PENDING_REVIEW'
        ]
      },
      sale: { $ref: '#/components/schemas/PharmacyCounterSale' },
      void_request: {
        allOf: [{ $ref: '#/components/schemas/PharmacyCounterSaleVoidTask' }],
        nullable: true
      },
      refund: {
        allOf: [{ $ref: '#/components/schemas/PharmacyCounterSaleVoidRefund' }],
        nullable: true
      },
      actions: {
        allOf: [{ $ref: '#/components/schemas/PharmacyCounterSaleVoidActions' }],
        nullable: true
      }
    }
  },

  PharmacyCounterSaleSellableItem: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      facility_id: positiveInt32,
      sku_code: { type: 'string' },
      display_name: { type: 'string' },
      generic_name: { type: 'string', nullable: true },
      brand_name: { type: 'string', nullable: true },
      form: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      unit_label: { type: 'string' },
      schedule_class: { type: 'string', nullable: true },
      is_narcotic: { type: 'boolean' },
      hsn_code: { type: 'string', nullable: true },
      in_stock_quantity: {
        type: 'number',
        description: 'Total usable (in_stock, non-expired) quantity.'
      },
      fefo_batch_id: { type: 'integer', nullable: true },
      fefo_batch_number: { type: 'string', nullable: true },
      fefo_expiry_date: { type: 'string', format: 'date', nullable: true },
      fefo_unit_price: {
        type: 'number',
        nullable: true,
        description: 'MRP of the FEFO head batch (the price the next unit sells at).'
      }
    }
  },

  PharmacyCounterSaleSellableItemList: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSaleSellableItem' }
      }
    }
  },

  PharmacyCounterSaleList: {
    type: 'object',
    required: ['sales'],
    properties: {
      sales: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSale' }
      }
    }
  },

  PharmacyCounterSaleCreateResponse: envelope('PharmacyCounterSaleCreateResult'),
  PharmacyCounterSaleVoidResponse: envelope('PharmacyCounterSaleVoidResult'),
  PharmacyCounterSaleVoidStatusResponse: envelope('PharmacyCounterSaleVoidStatusResult'),
  PharmacyCounterSaleResponse: envelope('PharmacyCounterSale'),
  PharmacyCounterSaleListResponse: envelope('PharmacyCounterSaleList'),
  PharmacyCounterSaleSellableItemsResponse: envelope('PharmacyCounterSaleSellableItemList'),
  PharmacyCounterSaleFacilityGrantsResponse: envelope(
    'PharmacyCounterSaleFacilityGrantList'
  ),
  PharmacyCounterSaleWitnessApprovalResponse: envelope('PharmacyCounterSaleWitnessApproval'),
  PharmacyInventoryDisposalWitnessApprovalResponse: envelope(
    'PharmacyInventoryDisposalWitnessApproval'
  ),
  PharmacyInventoryDisposalResponse: envelope('PharmacyInventoryDisposalResult'),
  PharmacyInventoryScheduleRegisterResponse: listEnvelope(
    'PharmacyInventoryScheduleRegisterEntry'
  )
};

const counterSaleItemsQueryParameters = [
  {
    name: 'facility_id',
    in: 'query',
    required: true,
    description:
      'Exact dispensing facility to search. Proved against the caller’s active pharmacy grant before any stock is read.',
    schema: positiveInt32
  },
  {
    name: 'q',
    in: 'query',
    required: false,
    schema: { type: 'string' }
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 }
  }
];

const counterSaleListQueryParameters = [
  {
    name: 'facility_id',
    in: 'query',
    required: false,
    description:
      'Narrows the list to one granted facility. Omitting it lists every facility the caller holds an active grant for — never the whole tenant.',
    schema: positiveInt32
  },
  {
    name: 'status',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      enum: ['IN_PROGRESS', 'COMPLETED', 'VOID_PENDING_REFUND', 'VOIDED', 'FAILED']
    }
  },
  {
    name: 'date',
    in: 'query',
    required: false,
    description: 'IST calendar date of the sale.',
    schema: { type: 'string', format: 'date' }
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200 }
  }
];

const canonicalUtcTimestamp = {
  type: 'string',
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
};

const scheduleRegisterQueryParameters = [
  {
    name: 'facility_id',
    in: 'query',
    required: true,
    schema: positiveInt32
  },
  {
    name: 'schedule_class',
    in: 'query',
    required: false,
    schema: { type: 'string', enum: ['H', 'H1', 'X'] }
  },
  {
    name: 'item_id',
    in: 'query',
    required: false,
    schema: positiveInt32
  },
  {
    name: 'date_from',
    in: 'query',
    required: false,
    schema: canonicalUtcTimestamp
  },
  {
    name: 'date_to',
    in: 'query',
    required: false,
    schema: canonicalUtcTimestamp
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 }
  }
];

const DESCRIPTIONS = {
  facilities:
    'Lists the authenticated actor’s OWN active pharmacy facility grants (facility identity plus grant id and authority version). The counter picker is fed from this so the client never names its own authority scope; a revoked grant simply stops appearing. Nothing here widens access — every counter-sale call re-proves the grant.',
  items:
    'POS pick list for one granted facility: active drug-master items with total usable stock and the FEFO head batch (number, expiry, MRP-derived unit price — what the next unit actually sells at). Expired, quarantined and depleted batches are excluded. facility_id is required and is proved against the caller’s active pharmacy grant before any row is read, so another facility’s stock is never returned.',
  create:
    'Sells a walk-in counter sale end-to-end under one required stable Idempotency-Key: FEFO batch allocation, atomic stock decrement, schedule-class and witness enforcement, billingV2 PHARMACY invoice, and pay-at-counter collection. Every non-CASH mode requires the bounded original external receipt or instrument reference; legacy evidence is never fabricated. CASH requires the seller’s open cash-drawer session. Equivalent requests through the pharmacy alias and canonical pharmacy-orders mount share one durable mutation identity.',
  requestWitnessApproval:
    'Seller creates a short-lived pending witness approval bound to the authenticated seller and the exact prospective sale payload. facility_id is a request, not authority: the seller’s ACTIVE grant on it is proved before any inventory row is read, so this surface cannot be used to probe another facility’s catalogue.',
  approveWitnessApproval:
    'A separately authenticated eligible pharmacy, medical, or nursing witness approves the unchanged sale payload. The seller may then submit the returned one-time approval id; self-witness, administrative/nonclinical witnesses, tenant mismatch, expiry, replay, and payload changes fail closed.',
  list: 'Lists counter sales newest first for the facilities the caller holds an ACTIVE pharmacy grant for — tenant scope alone is not custody authority — including durable void request/refund status and server-derived void readiness. VOID_PENDING_REFUND remains unavailable for resale or restock while finance approval, payout evidence, rejection review, or pharmacy reconciliation is outstanding.',
  detail:
    'Returns one sale with line and exact FEFO allocation evidence plus its latest durable void/refund presentation fields. The sale’s OWN facility is resolved from the stored row and the caller’s active grant is proved against THAT facility, so a guessed id belonging to another facility fails closed; a sale with no authoritative facility assignment also fails closed rather than inferring custody. A legacy non-CASH sale lacking the original payment reference is reported as fail-closed rather than made refund-ready.',
  void:
    'Starts, but does not complete, a same-day void for medicine explicitly confirmed never handed over. The server creates one tenant-bound full-amount PENDING refund tied to the exact sale, invoice, patient, mode, payment and command identity, parks the sale in VOID_PENDING_REFUND, and returns 202 with finance and pharmacy action links plus a staged task/SLA. The void role roster is not custody: the sale’s OWN facility is resolved from the stored row and the caller’s ACTIVE grant on THAT facility is proved first, exactly as the void-status read proves it. Pharmacy cannot approve or pay the refund. No stock or controlled-register return occurs until the separately authorized billing/gateway workflow has durably reached PAID with the required manual, processed-gateway, or offline-electronic evidence. Patient-returned medicine fails closed into the governed return/quarantine workflow.',
  voidStatus:
    'Reads the authoritative tenant-scoped counter-sale void obligation, exact refund status, staged task/SLA, reconciliation state, and strict local Staff action targets. The caller must hold an ACTIVE pharmacy grant on the sale’s own facility — the identical test every void mutation applies. NOT_REQUESTED is returned with null obligation/refund/actions when no request exists; rejected refunds remain REFUND_REJECTED_REVIEW with stock and sale locked.',
  reconcileVoid:
    'Idempotently rechecks the exact bound refund and advances the staged task. A caller-driven reconcile requires the caller’s ACTIVE grant on the sale’s own facility, the same test the void-status read applies; the scheduled tenant sweep runs as the system actor. It returns pending while approval, payout, or rail evidence is incomplete; a rejected refund enters explicit custody review without reopening or restocking. Only a durably PAID exact full refund with valid CASH drawer/voucher, processed gateway, or governed offline-electronic evidence can atomically restock every exact allocation, write controlled-register returns, complete task/SLA evidence, and mark the sale VOIDED. Retries after crashes are safe.',
  resolveRejectedVoid:
    'Closes a rejected-refund custody review only after a pharmacy incharge or admin holding an ACTIVE grant on the sale’s own facility explicitly confirms customer handover with a reason. It verifies that no stock return occurred, closes the task/SLA with domain evidence, and restores the sale to COMPLETED without restocking. It never converts a rejected refund into a payout or silently reopens the sale.'
};

function ops(prefix) {
  return {
    [`GET ${prefix}/counter-sales/facilities`]: {
      description: DESCRIPTIONS.facilities,
      response: 'PharmacyCounterSaleFacilityGrantsResponse',
      security: bearerSecurity
    },
    [`GET ${prefix}/counter-sales/items`]: {
      description: DESCRIPTIONS.items,
      response: 'PharmacyCounterSaleSellableItemsResponse',
      security: bearerSecurity,
      parameters: counterSaleItemsQueryParameters
    },
    [`POST ${prefix}/counter-sales`]: {
      description: DESCRIPTIONS.create,
      request: 'PharmacyCounterSaleCreateRequest',
      response: 'PharmacyCounterSaleCreateResponse',
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/counter-sales/witness-approvals`]: {
      description: DESCRIPTIONS.requestWitnessApproval,
      request: 'PharmacyCounterSaleWitnessApprovalRequest',
      response: 'PharmacyCounterSaleWitnessApprovalResponse',
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/counter-sales/witness-approvals/{id}/approve`]: {
      description: DESCRIPTIONS.approveWitnessApproval,
      request: 'PharmacyCounterSaleWitnessApprovalDecisionRequest',
      response: 'PharmacyCounterSaleWitnessApprovalResponse',
      security: bearerSecurity,
      pathParameters: { id: approvalIdPathSchema },
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/inventory/v2/disposals`]: {
      description:
        'Disposes a positive quantity from one exact batch under fixed server-side disposal semantics. The authenticated operator must be active PHARMACY_STAFF or PHARMACY_INCHARGE and hold an ACTIVE grant for the batch facility; item, catalogue, location, batch, and facility lineage are revalidated under lock. Schedule H/H1/X and narcotic custody is recorded in the statutory register, while Schedule X or narcotic disposal additionally consumes an independently approved one-time witness approval. Equivalent pharmacy and pharmacy-orders aliases share one durable idempotency identity.',
      request: 'PharmacyInventoryDisposalRequest',
      response: 'PharmacyInventoryDisposalResponse',
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/inventory/v2/disposals/witness-approvals`]: {
      description:
        'Creates a short-lived pending approval bound to an authenticated active PHARMACY_STAFF or PHARMACY_INCHARGE disposal operator and the exact unchanged Schedule X or narcotic batch-disposal intent. Only a second active pharmacy operator holding an ACTIVE grant for this exact facility may approve it; caller-selected grant authority is never accepted.',
      request: 'PharmacyInventoryDisposalWitnessApprovalRequest',
      response: 'PharmacyInventoryDisposalWitnessApprovalResponse',
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/inventory/v2/disposals/witness-approvals/{id}/approve`]: {
      description:
        'A second independently authenticated active PHARMACY_STAFF or PHARMACY_INCHARGE operator holding an ACTIVE grant for the exact disposal facility approves the unchanged intent. Self-witness, grant drift, tenant or scope mismatch, expiry, replay, and payload changes fail closed; password credentials are excluded from the canonical idempotency projection.',
      request: 'PharmacyInventoryDisposalWitnessApprovalDecisionRequest',
      response: 'PharmacyInventoryDisposalWitnessApprovalResponse',
      security: bearerSecurity,
      pathParameters: { id: approvalIdPathSchema },
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/inventory/v2/controlled-dispense`]: {
      description:
        'Retired standalone controlled-dispense tombstone. Controlled dispensing must use the verified pharmacy-order or governed counter-sale workflow.',
      response: 'PharmacyInventoryStandaloneControlledDispenseRetiredResponse',
      responseStatus: 410,
      responseDescription: 'Standalone controlled dispensing is retired.',
      security: bearerSecurity,
    },
    [`POST ${prefix}/inventory/v2/movements`]: {
      description:
        'Retired generic inventory-movement tombstone. Use the governed receipt, return, dispense, or disposal workflow.',
      response: 'PharmacyInventoryGenericMovementRetiredResponse',
      responseStatus: 410,
      responseDescription: 'Generic inventory movements are retired.',
      security: bearerSecurity,
    },
    [`POST ${prefix}/inventory/v2/movements/witness-approvals`]: {
      description:
        'Retired generic movement-witness tombstone. Witness approval is available only inside a typed inventory workflow.',
      response: 'PharmacyInventoryGenericMovementRetiredResponse',
      responseStatus: 410,
      responseDescription: 'Generic movement witness approvals are retired.',
      security: bearerSecurity,
    },
    [`POST ${prefix}/inventory/v2/movements/witness-approvals/{id}/approve`]: {
      description:
        'Retired generic movement-witness approval tombstone. Witness approval is available only inside a typed inventory workflow.',
      response: 'PharmacyInventoryGenericMovementRetiredResponse',
      responseStatus: 410,
      responseDescription: 'Generic movement witness approvals are retired.',
      security: bearerSecurity,
      pathParameters: { id: approvalIdPathSchema }
    },
    [`POST ${prefix}/inventory/v2/controlled-dispense/witness-approvals`]: {
      description:
        'Retired standalone controlled-dispense witness tombstone. Use the verified pharmacy-order or governed counter-sale witness workflow.',
      response: 'PharmacyInventoryStandaloneControlledDispenseRetiredResponse',
      responseStatus: 410,
      responseDescription: 'Standalone controlled dispensing is retired.',
      security: bearerSecurity,
    },
    [`POST ${prefix}/inventory/v2/controlled-dispense/witness-approvals/{id}/approve`]: {
      description:
        'Retired standalone controlled-dispense witness approval tombstone. Use the verified pharmacy-order or governed counter-sale witness workflow.',
      response: 'PharmacyInventoryStandaloneControlledDispenseRetiredResponse',
      responseStatus: 410,
      responseDescription: 'Standalone controlled dispensing is retired.',
      security: bearerSecurity,
      pathParameters: { id: approvalIdPathSchema }
    },
    [`GET ${prefix}/inventory/v2/schedule-register`]: {
      description:
        'Lists append-only Schedule H, H1, and X register entries newest first for one exact facility after proving the authenticated pharmacy actor holds an ACTIVE grant on that facility. Current item and batch lineage is revalidated for every historical row; corrupt or truncated statutory evidence fails closed rather than being omitted or rewritten.',
      response: 'PharmacyInventoryScheduleRegisterResponse',
      security: bearerSecurity,
      parameters: scheduleRegisterQueryParameters
    },
    [`GET ${prefix}/counter-sales`]: {
      description: DESCRIPTIONS.list,
      response: 'PharmacyCounterSaleListResponse',
      security: bearerSecurity,
      parameters: counterSaleListQueryParameters
    },
    [`GET ${prefix}/counter-sales/{id}`]: {
      description: DESCRIPTIONS.detail,
      response: 'PharmacyCounterSaleResponse',
      pathParameters: { id: approvalIdPathSchema }
    },
    [`GET ${prefix}/counter-sales/{id}/void-status`]: {
      description: DESCRIPTIONS.voidStatus,
      response: 'PharmacyCounterSaleVoidStatusResponse',
      pathParameters: { id: approvalIdPathSchema },
      security: bearerSecurity
    },
    [`POST ${prefix}/counter-sales/{id}/void`]: {
      description: DESCRIPTIONS.void,
      request: 'PharmacyCounterSaleVoidRequest',
      response: 'PharmacyCounterSaleVoidResponse',
      responseStatus: 202,
      pathParameters: { id: approvalIdPathSchema },
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/counter-sales/{id}/void/reconcile`]: {
      description: DESCRIPTIONS.reconcileVoid,
      response: 'PharmacyCounterSaleVoidResponse',
      pathParameters: { id: approvalIdPathSchema },
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    },
    [`POST ${prefix}/counter-sales/{id}/void/rejection/resolve`]: {
      description: DESCRIPTIONS.resolveRejectedVoid,
      request: 'PharmacyCounterSaleVoidRejectionResolutionRequest',
      response: 'PharmacyCounterSaleVoidResponse',
      pathParameters: { id: approvalIdPathSchema },
      security: bearerSecurity,
      parameters: [idempotencyKeyParameter],
      additionalResponses: witnessErrorResponses({ idempotent: true })
    }
  };
}

// The pharmacy router is mounted at both /api/v1/pharmacy-orders (canonical)
// and /api/v1/pharmacy (alias); the spec captures both.
export const operations = {
  ...ops('/api/v1/pharmacy-orders'),
  ...ops('/api/v1/pharmacy')
};
