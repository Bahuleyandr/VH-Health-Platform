import { envelope } from './_helpers.mjs';

const CATEGORIES = [
  'stent',
  'balloon',
  'guidewire',
  'catheter',
  'sheath',
  'closure_device',
  'pacemaker',
  'lead',
  'other'
];
const CATALOG_STATUSES = ['active', 'retired'];
const INVENTORY_DECREMENT_STATUSES = [
  'pending',
  'not_linked',
  'decremented',
  'insufficient_stock',
  'error'
];
const BILLING_GAP_REASONS = [
  'procedure_not_completed',
  'wastage_review_required',
  'billing_code_not_mapped',
  'billing_code_invalid',
  'billing_disabled',
  'billing_pending_or_failed'
];

const nullableString = { type: 'string', nullable: true };
const nullableDate = { type: 'string', format: 'date', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const nullableNumber = { type: 'number', nullable: true };
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
const NULLABLE_BIGINT_WIRE = { ...BIGINT_WIRE, nullable: true };
const FIXED_QUANTITY_WIRE = {
  type: 'string',
  pattern: '^(?:0|[1-9][0-9]*)\\.[0-9]{4}$',
  description: 'Non-negative quantity rendered with exactly four decimal places.'
};

const countData = (arrayKey, itemSchemaName) => ({
  type: 'object',
  additionalProperties: false,
  required: [arrayKey, 'count'],
  properties: {
    [arrayKey]: {
      type: 'array',
      items: { $ref: `#/components/schemas/${itemSchemaName}` }
    },
    count: { type: 'integer', minimum: 0 }
  }
});

const queryParameter = (name, schema) => ({
  name,
  in: 'query',
  required: false,
  schema
});

const idempotencyHeaderParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$'
  }
};

export const schemas = {
  CathConsumableCatalogItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'tenant_id',
      'inventory_item_id',
      'item_name',
      'category',
      'manufacturer',
      'model',
      'is_implant',
      'batch_tracked',
      'default_unit_cost_reference',
      'billing_item_code',
      'status',
      'retired_at',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'metadata',
      'inventory_sku',
      'inventory_item_name',
      'inventory_unit_label'
    ],
    properties: {
      id: BIGINT_WIRE,
      tenant_id: { type: 'string', format: 'uuid' },
      inventory_item_id: nullableInteger,
      item_name: { type: 'string' },
      category: { type: 'string', enum: CATEGORIES },
      manufacturer: nullableString,
      model: nullableString,
      is_implant: { type: 'boolean' },
      batch_tracked: { type: 'boolean' },
      default_unit_cost_reference: nullableNumber,
      billing_item_code: nullableString,
      status: { type: 'string', enum: CATALOG_STATUSES },
      retired_at: nullableDateTime,
      created_by: nullableUuid,
      updated_by: nullableUuid,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      metadata: { type: 'object', additionalProperties: true },
      inventory_sku: nullableString,
      inventory_item_name: nullableString,
      inventory_unit_label: nullableString
    }
  },

  CathConsumableCatalogListData: countData('items', 'CathConsumableCatalogItem'),
  CathConsumableCatalogListResponse: envelope('CathConsumableCatalogListData'),

  CathConsumableCatalogUpsertRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['item_name'],
    properties: {
      id: BIGINT_WIRE,
      inventory_item_id: { type: 'integer', nullable: true, minimum: 1 },
      item_name: { type: 'string', minLength: 1, maxLength: 255 },
      category: { type: 'string', enum: CATEGORIES },
      manufacturer: { type: 'string', nullable: true, maxLength: 255 },
      model: { type: 'string', nullable: true, maxLength: 160 },
      is_implant: { type: 'boolean' },
      batch_tracked: { type: 'boolean' },
      default_unit_cost_reference: { type: 'number', nullable: true, minimum: 0 },
      billing_item_code: { type: 'string', nullable: true, maxLength: 50 },
      status: { type: 'string', enum: CATALOG_STATUSES },
      metadata: { type: 'object', additionalProperties: true }
    }
  },

  CathConsumableCatalogMutationData: {
    type: 'object',
    additionalProperties: false,
    required: ['item'],
    properties: {
      item: { $ref: '#/components/schemas/CathConsumableCatalogItem' }
    }
  },
  CathConsumableCatalogMutationResponse: envelope('CathConsumableCatalogMutationData'),

  CathConsumableBatch: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'inventory_item_id',
      'batch_number',
      'lot_number',
      'expiry_date',
      'remaining_quantity',
      'status',
      'unit_cost_minor',
      'mrp_minor'
    ],
    properties: {
      id: { type: 'integer' },
      inventory_item_id: { type: 'integer' },
      batch_number: nullableString,
      lot_number: nullableString,
      expiry_date: { type: 'string', format: 'date' },
      remaining_quantity: { type: 'number' },
      status: { type: 'string' },
      unit_cost_minor: nullableInteger,
      mrp_minor: nullableInteger
    }
  },

  CathConsumableBatchListData: countData('batches', 'CathConsumableBatch'),
  CathConsumableBatchListResponse: envelope('CathConsumableBatchListData'),

  CathConsumableBillingLineReference: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'source_id'],
    properties: {
      type: { type: 'string', enum: ['procedure', 'consumable'] },
      source_id: BIGINT_WIRE,
      line_id: nullableInteger,
      reason: nullableString
    }
  },

  CathConsumableBillingHook: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'emitted', 'unmapped'],
    properties: {
      status: {
        type: 'string',
        enum: [
          'disabled',
          'finance_review_required',
          'procedure_not_completed',
          'partial',
          'emitted',
          'error'
        ]
      },
      invoice_id: nullableInteger,
      emitted: { type: 'integer', minimum: 0 },
      unmapped: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
      message: nullableString,
      emitted_lines: {
        type: 'array',
        items: { $ref: '#/components/schemas/CathConsumableBillingLineReference' }
      },
      unmapped_items: {
        type: 'array',
        items: { $ref: '#/components/schemas/CathConsumableBillingLineReference' }
      },
      failed_items: {
        type: 'array',
        items: { $ref: '#/components/schemas/CathConsumableBillingLineReference' }
      }
    }
  },

  CathCaseConsumableUsage: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'tenant_id',
      'case_id',
      'procedure_log_id',
      'catalog_item_id',
      'patient_uid',
      'inventory_batch_id',
      'quantity',
      'batch_tracked',
      'is_implant',
      'batch_number',
      'lot_number',
      'expiry_date',
      'serial_number',
      'unit_cost_snapshot',
      'used_by',
      'used_by_name',
      'used_at',
      'wasted',
      'waste_reason',
      'inventory_decrement_status',
      'inventory_movement_id',
      'inventory_warning',
      'timeline_event_id',
      'audit_event_id',
      'idempotency_key',
      'created_at',
      'updated_at',
      'metadata',
      'item_name',
      'category',
      'manufacturer',
      'model',
      'billing_item_code',
      'inventory_item_id',
      'inventory_sku',
      'inventory_item_name',
      'inventory_unit_label',
      'implant_record_id'
    ],
    properties: {
      id: BIGINT_WIRE,
      tenant_id: { type: 'string', format: 'uuid' },
      case_id: BIGINT_WIRE,
      procedure_log_id: { ...BIGINT_WIRE, nullable: true },
      catalog_item_id: BIGINT_WIRE,
      patient_uid: { type: 'string', format: 'uuid' },
      inventory_batch_id: nullableInteger,
      quantity: { type: 'number', minimum: 0.0001 },
      batch_tracked: { type: 'boolean' },
      is_implant: { type: 'boolean' },
      batch_number: nullableString,
      lot_number: nullableString,
      expiry_date: nullableDate,
      serial_number: nullableString,
      unit_cost_snapshot: nullableNumber,
      used_by: nullableUuid,
      used_by_name: nullableString,
      used_at: { type: 'string', format: 'date-time' },
      wasted: { type: 'boolean' },
      waste_reason: nullableString,
      inventory_decrement_status: {
        type: 'string',
        enum: INVENTORY_DECREMENT_STATUSES
      },
      inventory_movement_id: nullableInteger,
      inventory_warning: nullableString,
      timeline_event_id: nullableUuid,
      audit_event_id: nullableUuid,
      idempotency_key: nullableString,
      idempotent_replay: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      metadata: { type: 'object', additionalProperties: true },
      item_name: { type: 'string' },
      category: { type: 'string', enum: CATEGORIES },
      manufacturer: nullableString,
      model: nullableString,
      billing_item_code: nullableString,
      inventory_item_id: nullableInteger,
      inventory_sku: nullableString,
      inventory_item_name: nullableString,
      inventory_unit_label: nullableString,
      implant_record_id: { ...BIGINT_WIRE, nullable: true },
      billing_hook: { $ref: '#/components/schemas/CathConsumableBillingHook' }
    }
  },

  CathCaseConsumableUsageListData: countData('usage', 'CathCaseConsumableUsage'),
  CathCaseConsumableUsageListResponse: envelope('CathCaseConsumableUsageListData'),

  CathCaseConsumableUsageCreateRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['catalog_item_id', 'quantity'],
    properties: {
      catalog_item_id: BIGINT_WIRE,
      procedure_log_id: BIGINT_WIRE,
      inventory_batch_id: { type: 'integer', minimum: 1 },
      quantity: { type: 'number', minimum: 0.0001 },
      batch_number: { type: 'string', maxLength: 120 },
      lot_number: { type: 'string', maxLength: 120 },
      expiry_date: { type: 'string', format: 'date' },
      serial_number: { type: 'string', maxLength: 160 },
      used_at: { type: 'string', format: 'date-time' },
      wasted: { type: 'boolean' },
      waste_reason: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true }
    }
  },

  CathCaseConsumableUsageMutationData: {
    type: 'object',
    additionalProperties: false,
    required: ['usage'],
    properties: {
      usage: { $ref: '#/components/schemas/CathCaseConsumableUsage' }
    }
  },
  CathCaseConsumableUsageMutationResponse: envelope('CathCaseConsumableUsageMutationData'),

  CathInventoryReconciliation: {
    type: 'object',
    additionalProperties: false,
    required: [
      'case_id',
      'usage_id',
      'patient_uid',
      'item_name',
      'catalog_item_id',
      'inventory_item_id',
      'inventory_batch_id',
      'batch_number',
      'documented_quantity',
      'decremented_quantity',
      'remaining_quantity',
      'inventory_decrement_status',
      'inventory_warning',
      'task_id',
      'task_status',
      'workflow_sla_instance_id',
      'sla_status',
      'sla_recorded_status',
      'due_at',
      'actionable',
      'coverage_gap',
      'deep_link',
      'retry_path'
    ],
    properties: {
      case_id: BIGINT_WIRE,
      usage_id: BIGINT_WIRE,
      patient_uid: { type: 'string', format: 'uuid' },
      item_name: { type: 'string', minLength: 1 },
      catalog_item_id: BIGINT_WIRE,
      inventory_item_id: BIGINT_WIRE,
      inventory_batch_id: NULLABLE_BIGINT_WIRE,
      batch_number: nullableString,
      documented_quantity: FIXED_QUANTITY_WIRE,
      decremented_quantity: FIXED_QUANTITY_WIRE,
      remaining_quantity: FIXED_QUANTITY_WIRE,
      inventory_decrement_status: {
        type: 'string',
        enum: ['insufficient_stock', 'decremented']
      },
      inventory_warning: { type: 'string' },
      task_id: BIGINT_WIRE,
      task_status: {
        type: 'string',
        enum: ['open', 'in_progress', 'blocked', 'completed', 'overdue']
      },
      workflow_sla_instance_id: { type: 'string', format: 'uuid' },
      sla_status: {
        type: 'string',
        enum: ['active', 'completed', 'breached', 'escalated']
      },
      sla_recorded_status: {
        type: 'string',
        enum: ['active', 'completed', 'breached', 'escalated']
      },
      due_at: { type: 'string', format: 'date-time' },
      actionable: { type: 'boolean' },
      coverage_gap: { type: 'boolean' },
      deep_link: {
        type: 'string',
        pattern: '^/pharmacy/cath-inventory-reconciliation\\?case_id=[1-9][0-9]*&consumable_usage_id=[1-9][0-9]*$'
      },
      retry_path: {
        type: 'string',
        pattern: '^/api/v1/cath-lab/cases/[1-9][0-9]*/consumables/[1-9][0-9]*/inventory-reconcile$'
      }
    }
  },

  CathInventoryReconciliationReadData: {
    type: 'object',
    additionalProperties: false,
    required: ['reconciliation'],
    properties: {
      reconciliation: { $ref: '#/components/schemas/CathInventoryReconciliation' }
    }
  },
  CathInventoryReconciliationReadResponse: envelope(
    'CathInventoryReconciliationReadData'
  ),

  CathInventoryReconciliationCommandData: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'reconciliation'],
    properties: {
      outcome: {
        type: 'string',
        enum: ['completed', 'still_insufficient']
      },
      reconciliation: { $ref: '#/components/schemas/CathInventoryReconciliation' }
    }
  },
  CathInventoryReconciliationCommandResponse: envelope(
    'CathInventoryReconciliationCommandData'
  ),

  CathConsumablesBillingSettings: {
    type: 'object',
    additionalProperties: false,
    required: [
      'tenant_id',
      'charge_enabled',
      'procedure_billing_code',
      'procedure_unit_price',
      'gst_rate',
      'finance_reviewed_at',
      'finance_reviewed_by',
      'acceptance_snapshot'
    ],
    properties: {
      tenant_id: { type: 'string', format: 'uuid' },
      charge_enabled: { type: 'boolean' },
      procedure_billing_code: nullableString,
      procedure_unit_price: nullableNumber,
      gst_rate: { type: 'number', minimum: 0, maximum: 28 },
      finance_reviewed_at: nullableDateTime,
      finance_reviewed_by: nullableUuid,
      acceptance_snapshot: {
        type: 'object',
        nullable: true,
        additionalProperties: true
      },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' }
    }
  },

  CathConsumablesBillingSettingsData: {
    type: 'object',
    additionalProperties: false,
    required: ['settings'],
    properties: {
      settings: { $ref: '#/components/schemas/CathConsumablesBillingSettings' }
    }
  },
  CathConsumablesBillingSettingsResponse: envelope('CathConsumablesBillingSettingsData'),

  CathConsumablesBillingSettingsUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      charge_enabled: { type: 'boolean' },
      procedure_billing_code: { type: 'string', nullable: true, maxLength: 50 },
      procedure_unit_price: { type: 'number', nullable: true, minimum: 0 },
      gst_rate: { type: 'number', minimum: 0, maximum: 28 },
      finance_reviewed_at: nullableDateTime,
      acceptance_snapshot: {
        type: 'object',
        additionalProperties: true
      }
    }
  },

  CathConsumableUnbilledUsageItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'usage_id',
      'case_id',
      'procedure_log_id',
      'patient_uid',
      'patient_name',
      'item_name',
      'category',
      'quantity',
      'wasted',
      'waste_reason',
      'used_at',
      'billing_item_code',
      'inventory_decrement_status',
      'billing_gap_reason'
    ],
    properties: {
      usage_id: BIGINT_WIRE,
      case_id: BIGINT_WIRE,
      procedure_log_id: { ...BIGINT_WIRE, nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      patient_name: nullableString,
      item_name: { type: 'string' },
      category: { type: 'string', enum: CATEGORIES },
      quantity: { type: 'number', minimum: 0.0001 },
      wasted: { type: 'boolean' },
      waste_reason: nullableString,
      used_at: { type: 'string', format: 'date-time' },
      billing_item_code: nullableString,
      inventory_decrement_status: {
        type: 'string',
        enum: INVENTORY_DECREMENT_STATUSES
      },
      billing_gap_reason: { type: 'string', enum: BILLING_GAP_REASONS }
    }
  },

  CathConsumableUnbilledUsageListData: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'count', 'total', 'page', 'limit'],
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/CathConsumableUnbilledUsageItem' }
      },
      count: { type: 'integer', minimum: 0 },
      total: { type: 'integer', minimum: 0 },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 }
    }
  },
  CathConsumableUnbilledUsageListResponse: envelope('CathConsumableUnbilledUsageListData')
};

const catalogQueryParameters = [
  queryParameter('q', { type: 'string' }),
  queryParameter('scan', { type: 'string' }),
  queryParameter('category', { type: 'string', enum: CATEGORIES }),
  queryParameter('status', { type: 'string', enum: CATALOG_STATUSES }),
  queryParameter('limit', { type: 'integer', minimum: 1, maximum: 500 })
];

export const operations = {
  'GET /api/v1/admin/cath-consumables/catalog': {
    parameters: [
      ...catalogQueryParameters.filter(parameter => parameter.name !== 'scan'),
      queryParameter('mapped', { type: 'boolean' })
    ],
    response: 'CathConsumableCatalogListResponse'
  },
  'PUT /api/v1/admin/cath-consumables/catalog': {
    request: 'CathConsumableCatalogUpsertRequest',
    response: 'CathConsumableCatalogMutationResponse'
  },
  'GET /api/v1/admin/cath-consumables/billing-settings': {
    response: 'CathConsumablesBillingSettingsResponse'
  },
  'PUT /api/v1/admin/cath-consumables/billing-settings': {
    request: 'CathConsumablesBillingSettingsUpdateRequest',
    response: 'CathConsumablesBillingSettingsResponse'
  },
  'GET /api/v1/admin/cath-consumables/unbilled-usage': {
    parameters: [
      queryParameter('date_from', { type: 'string', format: 'date' }),
      queryParameter('date_to', { type: 'string', format: 'date' }),
      queryParameter('category', { type: 'string', enum: CATEGORIES }),
      queryParameter('case_id', BIGINT_WIRE),
      queryParameter('page', { type: 'integer', minimum: 1 }),
      queryParameter('limit', { type: 'integer', minimum: 1, maximum: 200 })
    ],
    response: 'CathConsumableUnbilledUsageListResponse'
  },
  'GET /api/v1/cath-lab/consumables/catalog': {
    parameters: catalogQueryParameters,
    response: 'CathConsumableCatalogListResponse'
  },
  'GET /api/v1/cath-lab/consumables/catalog/{id}/batches': {
    response: 'CathConsumableBatchListResponse'
  },
  'GET /api/v1/cath-lab/cases/{id}/consumables': {
    response: 'CathCaseConsumableUsageListResponse'
  },
  'POST /api/v1/cath-lab/cases/{id}/consumables': {
    parameters: [idempotencyHeaderParameter],
    request: 'CathCaseConsumableUsageCreateRequest',
    response: 'CathCaseConsumableUsageMutationResponse'
  },
  'GET /api/v1/cath-lab/cases/{caseId}/consumables/{usageId}/inventory-reconcile': {
    description:
      'Returns the task-backed Cath consumable inventory shortfall and its current stock-movement evidence. Routine access is limited to PHARMACIST, PHARMACY_STAFF, and PHARMACY_INCHARGE. ADMIN and SUPER_ADMIN may use this read only for coverage-gap recovery when no active pharmacy operator is available.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    pathParameters: {
      caseId: BIGINT_WIRE,
      usageId: BIGINT_WIRE
    },
    response: 'CathInventoryReconciliationReadResponse'
  },
  'POST /api/v1/cath-lab/cases/{caseId}/consumables/{usageId}/inventory-reconcile': {
    description:
      'Atomically retries only the remaining Cath consumable inventory decrement and returns completed or still_insufficient with refreshed reconciliation evidence. This no-body command requires Idempotency-Key and is limited to PHARMACIST, PHARMACY_STAFF, and PHARMACY_INCHARGE. ADMIN and SUPER_ADMIN remain read-only coverage-gap recovery viewers and cannot perform this inventory mutation.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    pathParameters: {
      caseId: BIGINT_WIRE,
      usageId: BIGINT_WIRE
    },
    parameters: [idempotencyHeaderParameter],
    response: 'CathInventoryReconciliationCommandResponse'
  }
};
