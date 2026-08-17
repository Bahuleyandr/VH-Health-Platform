// apps/backend/scripts/openapi/schemas/pharmacyCounterSale.mjs
// Walk-in pharmacy point-of-sale (migration 684), served from
// /api/v1/pharmacy-orders/counter-sales/* (and the /api/v1/pharmacy alias).
// FEFO batch dispensing + schedule-class enforcement + billingV2 PHARMACY
// invoice with pay-at-counter, tied to the cashier's open cash-drawer session.
import { envelope } from './_helpers.mjs';

const witnessErrorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PharmacyControlledDispenseWitnessErrorResponse' },
    },
  },
});

const witnessErrorResponses = () => ({
  400: witnessErrorResponse('The dispense payload, witness identity, or credential pair was invalid.'),
  401: witnessErrorResponse('The independently supplied witness credentials were invalid.'),
  403: witnessErrorResponse('The authenticated caller or witness tenant/role was not permitted.'),
  404: witnessErrorResponse('The inventory item or witness approval was not found in this tenant.'),
  409: witnessErrorResponse('The approval expired, was consumed, or did not match the unchanged dispense.'),
  429: witnessErrorResponse('The witness credential attempt was rate limited or locked.'),
  500: witnessErrorResponse('The controlled-dispense approval could not be completed.'),
});

export const schemas = {
  PharmacyCounterSaleLineInput: {
    type: 'object',
    required: ['inventory_item_id', 'quantity'],
    properties: {
      inventory_item_id: { type: 'integer' },
      quantity: { type: 'number', minimum: 0.0001 },
    },
  },

  PharmacyCounterSaleRxInput: {
    type: 'object',
    description:
      'Prescription reference — REQUIRED (doctor_name plus reference or upload_id) when any line is Schedule H/H1/X or narcotic.',
    properties: {
      doctor_name: { type: 'string', nullable: true },
      reference: { type: 'string', nullable: true, description: 'Rx number / free reference.' },
      upload_id: { type: 'integer', nullable: true, description: 'Pointer into the tenant upload store (e.g. a photographed paper Rx).' },
      id_proof_type: { type: 'string', nullable: true },
      id_proof_last4: { type: 'string', nullable: true },
    },
  },

  PharmacyCounterSaleCreateRequest: {
    type: 'object',
    required: ['lines', 'payment_mode'],
    properties: {
      lines: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/PharmacyCounterSaleLineInput' },
      },
      patient_uid: {
        type: 'string', format: 'uuid', nullable: true,
        description: 'Registered patient. Omit for an anonymous walk-in (customer_name then required).',
      },
      customer_name: { type: 'string', nullable: true },
      customer_phone: { type: 'string', nullable: true },
      rx: { allOf: [{ $ref: '#/components/schemas/PharmacyCounterSaleRxInput' }], nullable: true },
      witness_approval_id: {
        type: 'integer',
        minimum: 1,
        nullable: true,
        description:
          'Approved, unexpired one-time witness approval returned by the two-person approval flow. Required for Schedule X / narcotic lines; caller-selected witness identity is never accepted.',
      },
      payment_mode: {
        type: 'string',
        enum: ['CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET'],
      },
      payment_reference: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      sold_by_name: { type: 'string', nullable: true },
    },
  },

  PharmacyCounterSaleWitnessApprovalRequest: {
    allOf: [{ $ref: '#/components/schemas/PharmacyCounterSaleCreateRequest' }],
    description:
      'The exact prospective sale payload to bind to a short-lived pending witness approval. Omit witness_approval_id until final submission.',
  },

  PharmacyCounterSaleWitnessApprovalDecisionRequest: {
    type: 'object',
    required: ['sale'],
    properties: {
      sale: {
        $ref: '#/components/schemas/PharmacyCounterSaleWitnessApprovalRequest',
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
          'Witness password for the one-request step-up. It is neither returned nor persisted and does not replace the seller session.',
      },
    },
  },

  PharmacyCounterSaleWitnessApproval: {
    type: 'object',
    required: ['id', 'status', 'expires_at'],
    properties: {
      id: {
        type: 'string',
        pattern: '^[1-9][0-9]*$',
        description: 'BIGSERIAL approval id serialized as text.',
      },
      status: { type: 'string', enum: ['pending', 'approved'] },
      expires_at: { type: 'string', format: 'date-time' },
      decided_at: { type: 'string', format: 'date-time', nullable: true },
      witness: {
        type: 'object',
        nullable: true,
        readOnly: true,
        properties: {
          uid: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
  },

  PharmacyInventoryWitnessApprovalRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['inventory_item_id', 'quantity'],
    properties: {
      inventory_item_id: { type: 'integer', minimum: 1 },
      inventory_batch_id: { type: 'integer', minimum: 1, nullable: true },
      quantity: { type: 'number', minimum: 0.0001 },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      prescription_id: { type: 'integer', minimum: 1, nullable: true },
      prescription_number: { type: 'string', nullable: true },
      prescriber_uid: { type: 'string', format: 'uuid', nullable: true },
      prescriber_name: { type: 'string', nullable: true },
      prescriber_registration: { type: 'string', nullable: true },
      patient_id_proof_type: { type: 'string', nullable: true },
      patient_id_proof_last4: { type: 'string', nullable: true },
    },
  },

  PharmacyInventoryWitnessApprovalDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['dispense'],
    properties: {
      dispense: { $ref: '#/components/schemas/PharmacyInventoryWitnessApprovalRequest' },
      employeeId: {
        type: 'string',
        pattern: '^[A-Z0-9-]{3,20}$',
        description:
          'Witness employee ID for an in-session password step-up. Supply with password; otherwise the authenticated bearer is the witness.',
      },
      password: {
        type: 'string',
        format: 'password',
        minLength: 6,
        maxLength: 100,
        writeOnly: true,
        description:
          'Witness password for the one-request step-up. Supply with employeeId; it is never returned or persisted.',
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

  PharmacyControlledDispenseWitnessErrorResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string' },
      requestId: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
    },
  },

  PharmacyCounterSaleAllocation: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'BIGSERIAL id serialized as text.' },
      inventory_batch_id: { type: 'integer' },
      batch_number: { type: 'string' },
      expiry_date: { type: 'string', format: 'date' },
      quantity: { type: 'number' },
      unit_price: { type: 'number' },
      movement_id: { type: 'integer', description: 'The pharmacy_stock_movements issue row this allocation committed with.' },
      return_movement_id: { type: 'integer', nullable: true, description: 'Set once a void restocked this allocation.' },
    },
  },

  PharmacyCounterSaleLine: {
    type: 'object',
    properties: {
      id: { type: 'string' },
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
        items: { $ref: '#/components/schemas/PharmacyCounterSaleAllocation' },
      },
    },
  },

  PharmacyCounterSale: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'BIGSERIAL id serialized as text.' },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      customer_name: { type: 'string', nullable: true },
      customer_phone: { type: 'string', nullable: true },
      rx_doctor_name: { type: 'string', nullable: true },
      rx_reference: { type: 'string', nullable: true },
      rx_upload_id: { type: 'integer', nullable: true },
      status: { type: 'string', enum: ['IN_PROGRESS', 'COMPLETED', 'VOIDED', 'FAILED'] },
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
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      lines: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSaleLine' },
      },
    },
  },

  PharmacyCounterSaleCreateResult: {
    type: 'object',
    required: ['sale'],
    properties: {
      sale: { $ref: '#/components/schemas/PharmacyCounterSale' },
      invoice: {
        type: 'object',
        description: 'The billingV2 PHARMACY invoice (issued + paid) backing the sale.',
      },
      payment: {
        type: 'object',
        description: 'The billing_payments row collected at the counter.',
      },
    },
  },

  PharmacyCounterSaleVoidRequest: {
    type: 'object',
    required: ['reason'],
    properties: {
      reason: { type: 'string' },
      voided_by_name: { type: 'string', nullable: true },
    },
  },

  PharmacyCounterSaleVoidResult: {
    type: 'object',
    required: ['sale'],
    properties: {
      sale: { $ref: '#/components/schemas/PharmacyCounterSale' },
      refund: {
        type: 'object',
        description: 'The billing_refunds row (raised, approved, and paid) for the void.',
      },
    },
  },

  PharmacyCounterSaleSellableItem: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
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
      in_stock_quantity: { type: 'number', description: 'Total usable (in_stock, non-expired) quantity.' },
      fefo_batch_id: { type: 'integer', nullable: true },
      fefo_batch_number: { type: 'string', nullable: true },
      fefo_expiry_date: { type: 'string', format: 'date', nullable: true },
      fefo_unit_price: { type: 'number', nullable: true, description: 'MRP of the FEFO head batch (the price the next unit sells at).' },
    },
  },

  PharmacyCounterSaleSellableItemList: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSaleSellableItem' },
      },
    },
  },

  PharmacyCounterSaleList: {
    type: 'object',
    required: ['sales'],
    properties: {
      sales: {
        type: 'array',
        items: { $ref: '#/components/schemas/PharmacyCounterSale' },
      },
    },
  },

  PharmacyCounterSaleCreateResponse: envelope('PharmacyCounterSaleCreateResult'),
  PharmacyCounterSaleVoidResponse: envelope('PharmacyCounterSaleVoidResult'),
  PharmacyCounterSaleResponse: envelope('PharmacyCounterSale'),
  PharmacyCounterSaleListResponse: envelope('PharmacyCounterSaleList'),
  PharmacyCounterSaleSellableItemsResponse: envelope('PharmacyCounterSaleSellableItemList'),
  PharmacyCounterSaleWitnessApprovalResponse: envelope('PharmacyCounterSaleWitnessApproval'),
  PharmacyInventoryWitnessApprovalResponse: envelope('PharmacyCounterSaleWitnessApproval'),
};

const DESCRIPTIONS = {
  items:
    'POS pick list: active drug-master items with total usable stock and the FEFO head batch (number, expiry, MRP-derived unit price — what the next unit actually sells at). Expired, quarantined and depleted batches are excluded.',
  create:
    'Sells a walk-in counter sale end-to-end: FEFO (earliest-expiry-first) batch allocation with atomic per-batch stock decrement, schedule-class enforcement (OTC free; Schedule H/H1 require the rx prescription reference; Schedule X / narcotics go through the witnessed statutory-register dispense), a billingV2 PHARMACY invoice priced at batch MRP with master-data GST, and the pay-at-counter payment — CASH requires the seller’s open cash-drawer session and stamps its shift for drawer reconciliation. Anonymous walk-ins pass customer_name/phone; registered patients pass patient_uid and additionally get a canonical clinical-timeline entry.',
  requestWitnessApproval:
    'Seller creates a short-lived pending witness approval bound to the authenticated seller and the exact prospective sale payload.',
  approveWitnessApproval:
    'A separately authenticated eligible pharmacy, medical, or nursing witness approves the unchanged sale payload. The seller may then submit the returned one-time approval id; self-witness, administrative/nonclinical witnesses, tenant mismatch, expiry, replay, and payload changes fail closed.',
  list:
    'Lists counter sales for the tenant, newest first; filterable by status (IN_PROGRESS/COMPLETED/VOIDED/FAILED) and IST sale date.',
  detail:
    'One counter sale with its lines and per-batch FEFO allocation evidence (batch, expiry, quantity, stock-movement ids).',
  void:
    'Same-day void of a completed counter sale: raises, approves and pays a billing refund for the collected amount, restocks every allocation into its exact batch, and writes statutory-register return rows for Schedule H/H1/X / narcotic lines. Later returns go through the billing refund workflow instead.',
};

function ops(prefix) {
  return {
    [`GET ${prefix}/counter-sales/items`]: {
      description: DESCRIPTIONS.items,
      response: 'PharmacyCounterSaleSellableItemsResponse',
    },
    [`POST ${prefix}/counter-sales`]: {
      description: DESCRIPTIONS.create,
      request: 'PharmacyCounterSaleCreateRequest',
      response: 'PharmacyCounterSaleCreateResponse',
    },
    [`POST ${prefix}/counter-sales/witness-approvals`]: {
      description: DESCRIPTIONS.requestWitnessApproval,
      request: 'PharmacyCounterSaleWitnessApprovalRequest',
      response: 'PharmacyCounterSaleWitnessApprovalResponse',
    },
    [`POST ${prefix}/counter-sales/witness-approvals/{id}/approve`]: {
      description: DESCRIPTIONS.approveWitnessApproval,
      request: 'PharmacyCounterSaleWitnessApprovalDecisionRequest',
      response: 'PharmacyCounterSaleWitnessApprovalResponse',
    },
    [`POST ${prefix}/inventory/v2/controlled-dispense/witness-approvals`]: {
      description:
        'Dispensing staff creates a short-lived pending witness approval bound to the authenticated dispenser and exact prospective inventory dispense payload.',
      request: 'PharmacyInventoryWitnessApprovalRequest',
      response: 'PharmacyInventoryWitnessApprovalResponse',
      additionalResponses: witnessErrorResponses(),
    },
    [`POST ${prefix}/inventory/v2/controlled-dispense/witness-approvals/{id}/approve`]: {
      description:
        'A separately authenticated eligible pharmacy, medical, or nursing witness approves the unchanged inventory dispense payload; self-witness, tenant mismatch, expiry, replay, and payload changes fail closed.',
      request: 'PharmacyInventoryWitnessApprovalDecisionRequest',
      response: 'PharmacyInventoryWitnessApprovalResponse',
      additionalResponses: witnessErrorResponses(),
    },
    [`GET ${prefix}/counter-sales`]: {
      description: DESCRIPTIONS.list,
      response: 'PharmacyCounterSaleListResponse',
    },
    [`GET ${prefix}/counter-sales/{id}`]: {
      description: DESCRIPTIONS.detail,
      response: 'PharmacyCounterSaleResponse',
    },
    [`POST ${prefix}/counter-sales/{id}/void`]: {
      description: DESCRIPTIONS.void,
      request: 'PharmacyCounterSaleVoidRequest',
      response: 'PharmacyCounterSaleVoidResponse',
    },
  };
}

// The pharmacy router is mounted at both /api/v1/pharmacy-orders (canonical)
// and /api/v1/pharmacy (alias); the spec captures both.
export const operations = {
  ...ops('/api/v1/pharmacy-orders'),
  ...ops('/api/v1/pharmacy'),
};
