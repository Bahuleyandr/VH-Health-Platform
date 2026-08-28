import { envelope, listEnvelope } from './_helpers.mjs';

const STATES = [
  'requested',
  'reserved',
  'short_supply',
  'substitution_pending',
  'controlled_handoff_required',
  'approved',
  'issued',
  'partially_received',
  'received',
  'return_pending',
  'reconciliation_required',
  'reconciled',
  'rejected',
  'cancelled',
  'closed',
];

const RECONCILIATION_DISPOSITIONS = [
  'transit_shortage',
  'ward_count_variance',
  'damaged_in_transit',
  'documented_exception',
];

const positiveId = { type: 'integer', minimum: 1, maximum: 2147483647 };
const positiveBigIntWire = {
  oneOf: [
    {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    {
      type: 'string',
      pattern: '^[1-9][0-9]*$',
      description: 'Positive decimal string when the identifier exceeds the JavaScript safe-integer range.',
    },
  ],
};
const versionProperties = {
  expected_version: {
    ...positiveId,
    description: 'Optimistic state version last read by the caller.',
  },
  state_version: {
    ...positiveId,
    description: 'Backward-compatible alias for expected_version.',
  },
};

const quantityEntry = (field, { allowZero = false } = {}) => ({
  type: 'object',
  additionalProperties: false,
  required: ['item_id', field],
  properties: {
    item_id: positiveId,
    [field]: {
      type: 'number',
      minimum: allowZero ? 0 : 0.01,
      multipleOf: 0.01,
    },
  },
});

const quantityRequest = (field) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...versionProperties,
    [field === 'quantity_reserved'
      ? 'item_quantities_reserved'
      : field === 'quantity_issued'
        ? 'item_quantities_issued'
        : field === 'quantity_received'
          ? 'item_quantities_received'
          : 'item_quantities_returned']: {
      type: 'array',
      minItems: 1,
      items: { $ref: `#/components/schemas/WardIndent${field
        .split('_')
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('')}Entry` },
    },
  },
});

export const schemas = {
  WardIndentItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'ward_indent_id', 'item_name'],
    properties: {
      id: positiveId,
      ward_indent_id: positiveId,
      item_name: { type: 'string' },
      pharmacy_catalog_id: { ...positiveId, nullable: true },
      clinical_order_id: { ...positiveId, nullable: true },
      fulfilment_status: { type: 'string', nullable: true },
      substitution_status: { type: 'string', nullable: true },
      controlled_reference_id: { type: 'string', nullable: true },
      controlled_movement_id: { ...positiveId, nullable: true },
      controlled_register_id: { ...positiveId, nullable: true },
      controlled_return_movement_id: { ...positiveId, nullable: true },
      controlled_return_register_id: { ...positiveId, nullable: true },
      quantity_requested: { type: 'number', minimum: 0.01, multipleOf: 0.01 },
      quantity_reserved: { type: 'number', minimum: 0, multipleOf: 0.01 },
      quantity_approved: { type: 'number', minimum: 0, multipleOf: 0.01 },
      quantity_issued: { type: 'number', minimum: 0, multipleOf: 0.01, nullable: true },
      quantity_received: { type: 'number', minimum: 0, multipleOf: 0.01 },
      quantity_variance_resolved: { type: 'number', minimum: 0, multipleOf: 0.01 },
      quantity_return_requested: { type: 'number', minimum: 0, multipleOf: 0.01 },
      quantity_returned: { type: 'number', minimum: 0, multipleOf: 0.01 },
    },
  },
  WardIndentWorkflow: {
    type: 'object',
    additionalProperties: true,
    required: ['owner_role_codes', 'active_slas'],
    properties: {
      owner_role_codes: { type: 'array', items: { type: 'string' } },
      active_slas: { type: 'array', items: { type: 'object', additionalProperties: true } },
      events: { type: 'array', items: { type: 'object', additionalProperties: true } },
      controlled_handoff_references: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item_id', 'reference_id'],
          properties: {
            item_id: positiveId,
            reference_id: { type: 'string' },
          },
        },
      },
    },
  },
  WardIndent: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'indent_number', 'status', 'state_version', 'items'],
    properties: {
      id: positiveId,
      indent_number: { type: 'string' },
      status: { type: 'string', enum: STATES },
      state_version: positiveId,
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      admission_id: { ...positiveId, nullable: true },
      ward_id: { ...positiveId, nullable: true },
      owner_role_codes: { type: 'array', items: { type: 'string' } },
      items: { type: 'array', items: { $ref: '#/components/schemas/WardIndentItem' } },
      workflow: { $ref: '#/components/schemas/WardIndentWorkflow' },
    },
  },
  WardIndentResponse: envelope('WardIndent'),
  WardIndentListResponse: listEnvelope('WardIndent'),
  WardIndentNamedPayload: {
    type: 'object',
    additionalProperties: false,
    required: ['indent'],
    properties: { indent: { $ref: '#/components/schemas/WardIndent' } },
  },
  WardIndentNamedResponse: envelope('WardIndentNamedPayload'),
  WardIndentNamedListPayload: {
    type: 'object',
    additionalProperties: false,
    required: ['indents'],
    properties: {
      indents: { type: 'array', items: { $ref: '#/components/schemas/WardIndent' } },
    },
  },
  WardIndentNamedListResponse: envelope('WardIndentNamedListPayload'),
  WardIndentInventoryCandidateBatch: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'inventory_item_id', 'remaining_quantity', 'unreserved_quantity'],
    properties: {
      id: positiveId,
      inventory_item_id: positiveId,
      batch_number: { type: 'string' },
      lot_number: { type: 'string', nullable: true },
      expiry_date: { type: 'string', format: 'date' },
      remaining_quantity: { type: 'number', minimum: 0 },
      unreserved_quantity: { type: 'number', minimum: 0 },
      status: { type: 'string' },
    },
  },
  WardIndentInventoryCandidate: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'catalog_id', 'sku_code', 'display_name', 'unreserved_quantity', 'batches'],
    properties: {
      id: positiveId,
      catalog_id: positiveId,
      sku_code: { type: 'string' },
      display_name: { type: 'string' },
      generic_name: { type: 'string', nullable: true },
      brand_name: { type: 'string', nullable: true },
      form: { type: 'string', nullable: true },
      strength: { type: 'string', nullable: true },
      unit_label: { type: 'string', nullable: true },
      schedule_class: { type: 'string', nullable: true },
      is_narcotic: { type: 'boolean' },
      status: { type: 'string' },
      facility_id: { ...positiveId, nullable: true },
      unreserved_quantity: { type: 'number', minimum: 0 },
      batches: {
        type: 'array',
        items: { $ref: '#/components/schemas/WardIndentInventoryCandidateBatch' },
      },
    },
  },
  WardIndentInventoryCandidatesPayload: {
    type: 'object',
    additionalProperties: false,
    required: ['item', 'candidates'],
    properties: {
      item: { $ref: '#/components/schemas/WardIndentItem' },
      candidates: {
        type: 'array',
        items: { $ref: '#/components/schemas/WardIndentInventoryCandidate' },
      },
    },
  },
  WardIndentInventoryCandidatesResponse: envelope('WardIndentInventoryCandidatesPayload'),
  WardIndentNotificationCoverageRecoveryRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Maximum notification-coverage obligations inspected in this operator run.',
      },
    },
  },
  WardIndentNotificationCoverageRecoverySummary: {
    type: 'object',
    additionalProperties: false,
    required: [
      'scanned',
      'recovered',
      'held',
      'awaitingRecipients',
      'recoveredTaskIds',
      'heldTaskIds',
      'limit',
    ],
    properties: {
      scanned: { type: 'integer', minimum: 0 },
      recovered: { type: 'integer', minimum: 0 },
      held: { type: 'integer', minimum: 0 },
      awaitingRecipients: { type: 'integer', minimum: 0 },
      recoveredTaskIds: { type: 'array', uniqueItems: true, items: positiveId },
      heldTaskIds: { type: 'array', uniqueItems: true, items: positiveId },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  WardIndentNotificationCoverageRecoveryResponse: envelope(
    'WardIndentNotificationCoverageRecoverySummary',
  ),
  WardIndentCreateItem: {
    type: 'object',
    additionalProperties: false,
    required: ['quantity_requested'],
    properties: {
      pharmacy_catalog_id: positiveId,
      clinical_order_id: { ...positiveId, nullable: true },
      item_name: { type: 'string', minLength: 1 },
      quantity_requested: {
        type: 'number', minimum: 0.01, multipleOf: 0.01,
      },
      unit: { type: 'string', nullable: true },
      unit_price: { type: 'number', minimum: 0, nullable: true },
      notes: { type: 'string', nullable: true },
    },
    anyOf: [{ required: ['pharmacy_catalog_id'] }, { required: ['item_name'] }],
  },
  WardIndentCreateRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      ward_id: { ...positiveId, nullable: true },
      admission_id: { ...positiveId, nullable: true },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      indent_type: {
        type: 'string',
        enum: ['pharmacy', 'consumables', 'linen', 'sterile_supplies'],
        default: 'pharmacy',
      },
      items: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/WardIndentCreateItem' },
      },
      notes: { type: 'string', nullable: true },
    },
  },
  WardIndentQuantityReservedEntry: quantityEntry('quantity_reserved'),
  WardIndentQuantityIssuedEntry: quantityEntry('quantity_issued'),
  WardIndentQuantityReceivedEntry: quantityEntry('quantity_received', { allowZero: true }),
  WardIndentQuantityReturnedEntry: quantityEntry('quantity_returned', { allowZero: true }),
  WardIndentInventorySelection: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'inventory_item_id'],
    properties: {
      item_id: positiveId,
      inventory_item_id: positiveId,
    },
  },
  WardIndentReserveRequest: {
    ...quantityRequest('quantity_reserved'),
    properties: {
      ...quantityRequest('quantity_reserved').properties,
      inventory_selections: {
        type: 'array',
        uniqueItems: true,
        items: { $ref: '#/components/schemas/WardIndentInventorySelection' },
      },
    },
  },
  WardIndentIssueRequest: quantityRequest('quantity_issued'),
  WardIndentSubstitutionAcknowledgement: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id'],
    properties: {
      item_id: positiveId,
    },
  },
  WardIndentReceiveRequest: {
    ...quantityRequest('quantity_received'),
    properties: {
      ...quantityRequest('quantity_received').properties,
      substitution_acknowledgements: {
        type: 'array',
        uniqueItems: true,
        items: { $ref: '#/components/schemas/WardIndentSubstitutionAcknowledgement' },
      },
    },
  },
  WardIndentReturnRequest: {
    ...quantityRequest('quantity_returned'),
    required: ['item_quantities_returned', 'reason'],
    properties: {
      ...quantityRequest('quantity_returned').properties,
      reason: { type: 'string', minLength: 1 },
    },
  },
  WardIndentShortSupplyEntry: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'quantity_available'],
    properties: {
      item_id: positiveId,
      quantity_available: { type: 'number', minimum: 0, multipleOf: 0.01 },
    },
  },
  WardIndentShortSupplyRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'item_quantities_available'],
    properties: {
      ...versionProperties,
      reason: { type: 'string', minLength: 1 },
      item_quantities_available: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/WardIndentShortSupplyEntry' },
      },
      inventory_selections: {
        type: 'array',
        uniqueItems: true,
        items: { $ref: '#/components/schemas/WardIndentInventorySelection' },
      },
    },
  },
  WardIndentSubstitutionProposal: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'substitute_catalog_id', 'reason'],
    properties: {
      item_id: positiveId,
      substitute_catalog_id: positiveId,
      quantity: { type: 'number', minimum: 0.01, multipleOf: 0.01 },
      reason: { type: 'string', minLength: 1 },
    },
  },
  WardIndentSubstitutionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['substitutions'],
    properties: {
      ...versionProperties,
      substitutions: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/WardIndentSubstitutionProposal' },
      },
    },
  },
  WardIndentVersionRequest: {
    type: 'object',
    additionalProperties: false,
    properties: versionProperties,
  },
  WardIndentSubstitutionApprovalRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...versionProperties,
      inventory_selections: {
        type: 'array',
        uniqueItems: true,
        items: { $ref: '#/components/schemas/WardIndentInventorySelection' },
      },
    },
  },
  WardIndentReasonRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      ...versionProperties,
      reason: { type: 'string', minLength: 1 },
    },
  },
  WardIndentControlledEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'movement_id', 'register_id'],
    properties: {
      item_id: positiveId,
      movement_id: positiveId,
      register_id: positiveId,
    },
  },
  WardIndentControlledHandoffRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['item_evidence'],
    properties: {
      ...versionProperties,
      item_evidence: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/WardIndentControlledEvidence' },
      },
    },
  },
  WardIndentReconciliationItem: {
    type: 'object',
    additionalProperties: false,
    required: ['item_id', 'quantity_variance_resolved', 'disposition', 'note'],
    properties: {
      item_id: positiveId,
      quantity_variance_resolved: {
        type: 'number', minimum: 0.01, multipleOf: 0.01,
      },
      disposition: { type: 'string', enum: RECONCILIATION_DISPOSITIONS },
      note: { type: 'string', minLength: 1 },
    },
  },
  WardIndentAllocationReturn: {
    type: 'object',
    additionalProperties: false,
    required: ['allocation_id', 'quantity'],
    properties: {
      allocation_id: positiveBigIntWire,
      quantity: {
        type: 'number', minimum: 0.01, multipleOf: 0.01,
      },
    },
  },
  WardIndentReconcileRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      ...versionProperties,
      reason: { type: 'string', minLength: 1 },
      controlled_return_evidence: {
        type: 'array',
        items: { $ref: '#/components/schemas/WardIndentControlledEvidence' },
      },
      item_reconciliations: {
        type: 'array',
        items: { $ref: '#/components/schemas/WardIndentReconciliationItem' },
      },
      allocation_returns: {
        type: 'array',
        uniqueItems: true,
        items: { $ref: '#/components/schemas/WardIndentAllocationReturn' },
      },
    },
  },
};

const security = [{ ApiKeyAuth: [], BearerAuth: [] }];
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Stable command key. Exact retries replay the original durable state transition.',
  schema: { type: 'string', minLength: 1, maxLength: 200 },
};
const listParameters = [
  { name: 'ward_id', in: 'query', schema: positiveId },
  { name: 'status', in: 'query', schema: { type: 'string', enum: STATES } },
  { name: 'admission_id', in: 'query', schema: positiveId },
  { name: 'patient_uid', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'overdue_only', in: 'query', schema: { type: 'boolean' } },
  {
    name: 'worklist',
    in: 'query',
    schema: { type: 'string', enum: ['open', 'terminal', 'owned', 'overdue'] },
  },
  {
    name: 'before_requested_at',
    in: 'query',
    description: 'Exclusive ISO-8601 requested-at cursor. Must be supplied together with before_id.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'before_id',
    in: 'query',
    description: 'Exclusive positive indent identifier cursor. Must be supplied together with before_requested_at.',
    schema: positiveId,
  },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
];
const admissionListParameters = listParameters.filter((parameter) => (
  !['ward_id', 'admission_id', 'patient_uid'].includes(parameter.name)
));
const eventLimitParameter = {
  name: 'event_limit',
  in: 'query',
  schema: { type: 'integer', minimum: 1, maximum: 200 },
};

const ACTIONS = [
  ['reserve', 'WardIndentReserveRequest', 'Reserves exact per-line quantities against locked same-tenant catalog rows and advances the durable owner/SLA state.'],
  ['short-supply', 'WardIndentShortSupplyRequest', 'Records an evidenced stock shortfall and keeps the pharmacy response obligation open for substitution or rejection.'],
  ['substitutions', 'WardIndentSubstitutionRequest', 'Proposes same-tenant catalog substitutions for short-supply lines and transfers ownership to the prescriber decision role.'],
  ['substitutions/approve', 'WardIndentSubstitutionApprovalRequest', 'Authorizes pending substitutions as the prescribing clinician, preserving original and replacement catalog identity and any explicit Inventory V2 mapping selection.'],
  ['substitutions/reject', 'WardIndentReasonRequest', 'Rejects pending substitutions as the prescribing clinician and records the reason in the append-only workflow evidence.'],
  ['approve', 'WardIndentVersionRequest', 'Approves reserved supply; controlled lines stop at the mandatory controlled-handoff evidence gate.'],
  ['reject', 'WardIndentReasonRequest', 'Rejects the request as a terminal, reasoned pharmacy decision and closes its active SLA.'],
  ['controlled-handoff', 'WardIndentControlledHandoffRequest', 'Binds every controlled line to its sanctioned inventory movement and statutory register entry before issue.'],
  ['issue', 'WardIndentIssueRequest', 'Issues approved quantities, decrements non-controlled stock atomically, and transfers the receipt obligation to the ward.'],
  ['receive', 'WardIndentReceiveRequest', 'Records an independent ward receipt, supports partial receipt, and prevents the issuing actor from self-acknowledging.'],
  ['returns', 'WardIndentReturnRequest', 'Requests return of received quantities and opens reconciliation; controlled returns require sanctioned evidence at reconciliation.'],
  ['discrepancies', 'WardIndentReasonRequest', 'Records a receipt or count discrepancy and moves the request into exact-quantity reconciliation.'],
  ['reconcile', 'WardIndentReconcileRequest', 'Resolves every outstanding receipt variance and return, including controlled return movement/register evidence, before closure.'],
  ['cancel', 'WardIndentReasonRequest', 'Cancels an eligible pre-issue request with a durable reason, audit event, timeline event, and SLA closure.'],
  ['close', 'WardIndentReasonRequest', 'Closes only a fully received or reconciled request after all quantities and controlled evidence balance.'],
];

function mutationOverlay(description, request, response) {
  return {
    description,
    request,
    response,
    security,
    parameters: [idempotencyParameter],
  };
}

function addSurface(out, {
  prefix,
  idName,
  response,
  listResponse,
  named = false,
  inventoryCandidates = false,
  notificationCoverageRecovery = false,
}) {
  const idPath = `{${idName}}`;
  out[`GET ${prefix}`] = {
    description: 'Lists tenant-scoped ward indents with patient-access filtering and active owner/SLA projections.',
    response: listResponse,
    security,
    parameters: listParameters,
  };
  out[`POST ${prefix}`] = {
    ...mutationOverlay(
      'Creates a tenant-scoped ward indent with catalog snapshots, an append-only requested event, canonical timeline/audit evidence, and the pharmacy response SLA in one transaction.',
      'WardIndentCreateRequest',
      response,
    ),
    responseStatus: 201,
  };
  if (notificationCoverageRecovery) {
    out[`POST ${prefix}/notification-coverage/recover`] = mutationOverlay(
      'Runs a bounded, tenant-scoped operator recovery over open ward-indent notification-coverage obligations. Only evidence-backed notification outbox rows complete tasks; invalid stored intents are held and gaps without active recipients remain actionable.',
      'WardIndentNotificationCoverageRecoveryRequest',
      'WardIndentNotificationCoverageRecoveryResponse',
    );
  }
  out[`GET ${prefix}/${idPath}`] = {
    description: 'Returns one tenant-scoped ward indent with ordered lines, active SLA ownership, controlled-handoff references, and append-only transition history.',
    response,
    security,
    pathParameters: { [idName]: positiveId },
    parameters: [eventLimitParameter],
  };
  if (inventoryCandidates) {
    out[`GET ${prefix}/${idPath}/items/{itemId}/inventory-candidates`] = {
      description: 'Lists active, same-tenant Inventory V2 mappings and non-expired FEFO batch availability for one catalog-linked ward-indent line.',
      response: 'WardIndentInventoryCandidatesResponse',
      security,
      pathParameters: {
        [idName]: positiveId,
        itemId: positiveId,
      },
    };
  }
  for (const [action, request, description] of ACTIONS) {
    out[`POST ${prefix}/${idPath}/${action}`] = {
      ...mutationOverlay(description, request, response),
      pathParameters: { [idName]: positiveId },
    };
  }
  if (named) {
    out[`GET /api/v1/ipd/admissions/{id}/ward-indents`] = {
      description: 'Lists the tenant-scoped ward-indent workflow for one admission after admission-level patient-access authorization.',
      response: 'WardIndentNamedListResponse',
      security,
      pathParameters: { id: positiveId },
      parameters: admissionListParameters,
    };
  }
}

export const operations = {};
addSurface(operations, {
  prefix: '/api/v1/pharmacy-orders/ward-indents',
  idName: 'id',
  response: 'WardIndentResponse',
  listResponse: 'WardIndentListResponse',
  inventoryCandidates: true,
  notificationCoverageRecovery: true,
});
addSurface(operations, {
  prefix: '/api/v1/pharmacy/ward-indents',
  idName: 'id',
  response: 'WardIndentResponse',
  listResponse: 'WardIndentListResponse',
  inventoryCandidates: true,
  notificationCoverageRecovery: true,
});
addSurface(operations, {
  prefix: '/api/v1/ipd/ward-indents',
  idName: 'indentId',
  response: 'WardIndentNamedResponse',
  listResponse: 'WardIndentNamedListResponse',
  named: true,
  inventoryCandidates: true,
});
