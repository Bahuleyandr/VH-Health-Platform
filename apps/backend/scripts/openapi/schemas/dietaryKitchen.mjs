// apps/backend/scripts/openapi/schemas/dietaryKitchen.mjs
// Kitchen management on top of diet orders (migration 685), served from
// /api/v1/dietary/*: tenant menu master, per-meal kitchen production tickets
// generated daily for ACTIVE diet orders of admitted patients, and ward-side
// tray tracking (dispatched -> delivered -> collected).
import { envelope } from './_helpers.mjs';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const TICKET_STATUSES = [
  'pending', 'preparing', 'ready', 'dispatched', 'delivered', 'collected', 'cancelled',
];

export const schemas = {
  DietaryMenuItem: {
    type: 'object',
    required: ['id', 'name', 'meal_type', 'diet_types', 'is_veg', 'active'],
    properties: {
      id: { type: 'string', description: 'BIGSERIAL id serialized as text.' },
      tenant_id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      meal_type: { type: 'string', enum: MEAL_TYPES },
      diet_types: {
        type: 'array',
        items: { type: 'string' },
        description:
          "diet_orders.diet_type values this dish suits (vocabulary minus 'npo' — nil-by-mouth patients get no menu).",
      },
      is_veg: { type: 'boolean' },
      allergen_tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Lower-cased allergen tags (e.g. 'peanut', 'milk'); ticket generation excludes the item when any tag matches the order's allergies case-insensitively.",
      },
      active: { type: 'boolean' },
      notes: { type: 'string', nullable: true },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  DietaryMenuItemCreateRequest: {
    type: 'object',
    required: ['name', 'meal_type'],
    properties: {
      name: { type: 'string' },
      meal_type: { type: 'string', enum: MEAL_TYPES },
      diet_types: { type: 'array', items: { type: 'string' } },
      is_veg: { type: 'boolean', default: true },
      allergen_tags: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string', nullable: true },
    },
  },

  DietaryMenuItemUpdateRequest: {
    type: 'object',
    description: 'Partial update; omitted fields keep their current values. Deactivate with active=false (names free up for replacements).',
    properties: {
      name: { type: 'string' },
      meal_type: { type: 'string', enum: MEAL_TYPES },
      diet_types: { type: 'array', items: { type: 'string' } },
      is_veg: { type: 'boolean' },
      allergen_tags: { type: 'array', items: { type: 'string' } },
      active: { type: 'boolean' },
      notes: { type: 'string', nullable: true },
    },
  },

  DietaryMealTicket: {
    type: 'object',
    required: ['id', 'diet_order_id', 'patient_uid', 'service_date', 'meal_type', 'diet_type', 'status'],
    properties: {
      id: { type: 'string', description: 'BIGSERIAL id serialized as text.' },
      tenant_id: { type: 'string', format: 'uuid' },
      diet_order_id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      service_date: { type: 'string', format: 'date' },
      meal_type: { type: 'string', enum: MEAL_TYPES },
      admission_id: { type: 'integer', nullable: true },
      ward: { type: 'string', nullable: true },
      bed_number: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      diet_type: { type: 'string' },
      restrictions: { type: 'array', items: { type: 'string' } },
      allergies: { type: 'array', items: { type: 'string' } },
      calories_target: { type: 'number', nullable: true },
      menu_selections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            is_veg: { type: 'boolean' },
          },
        },
        description:
          'Menu items matched at generation (meal window + diet-type suitability + no allergen intersection). Empty when nothing suits; diet_spec then carries the free-text preparation spec.',
      },
      diet_spec: { type: 'string', nullable: true },
      special_instructions: { type: 'string', nullable: true },
      status: { type: 'string', enum: TICKET_STATUSES },
      generated_source: { type: 'string', enum: ['scheduler', 'manual', 'order_change'] },
      generated_by: { type: 'string', format: 'uuid', nullable: true },
      preparing_at: { type: 'string', format: 'date-time', nullable: true },
      ready_at: { type: 'string', format: 'date-time', nullable: true },
      dispatched_at: { type: 'string', format: 'date-time', nullable: true },
      delivered_at: { type: 'string', format: 'date-time', nullable: true },
      collected_at: { type: 'string', format: 'date-time', nullable: true },
      cancelled_at: { type: 'string', format: 'date-time', nullable: true },
      cancelled_by: { type: 'string', format: 'uuid', nullable: true },
      cancel_reason: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  DietaryMenuItemListData: {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/DietaryMenuItem' } },
    },
  },

  DietaryMealTicketListData: {
    type: 'object',
    required: ['serviceDate', 'tickets'],
    properties: {
      serviceDate: { type: 'string', format: 'date' },
      tickets: { type: 'array', items: { $ref: '#/components/schemas/DietaryMealTicket' } },
    },
  },

  DietaryKitchenGenerateRequest: {
    type: 'object',
    properties: {
      service_date: {
        type: 'string',
        format: 'date',
        nullable: true,
        description: 'YYYY-MM-DD; defaults to today (IST).',
      },
    },
  },

  DietaryKitchenGenerationResult: {
    type: 'object',
    required: ['serviceDate', 'considered', 'created'],
    properties: {
      serviceDate: { type: 'string', format: 'date' },
      considered: { type: 'integer', description: 'Eligible ACTIVE diet orders of currently admitted patients.' },
      created: { type: 'integer', description: 'Tickets newly cut; meals already holding a live ticket are skipped.' },
      byMeal: { type: 'object', additionalProperties: { type: 'integer' } },
    },
  },

  DietaryMealTicketStatusRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: TICKET_STATUSES.filter((s) => s !== 'pending'),
        description:
          'Target status. pending→preparing→ready→dispatched is the kitchen leg (dietary roles); dispatched→delivered→collected is ward-side tray tracking (any dietary-mount role). Cancel requires reason.',
      },
      reason: { type: 'string', nullable: true, description: 'Required when status=cancelled.' },
    },
  },

  DietaryProductionSummaryData: {
    type: 'object',
    required: ['serviceDate', 'totalLive', 'byMeal'],
    properties: {
      serviceDate: { type: 'string', format: 'date' },
      totalLive: { type: 'integer', description: 'Non-cancelled tickets for the day.' },
      byMeal: {
        type: 'object',
        description: 'Keyed by meal_type: what the kitchen cooks (counts by diet_type) plus a status rollup.',
        additionalProperties: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            by_diet_type: { type: 'object', additionalProperties: { type: 'integer' } },
            by_status: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
      },
    },
  },

  DietaryMenuItemResponse: envelope('DietaryMenuItem'),
  DietaryMenuItemListResponse: envelope('DietaryMenuItemListData'),
  DietaryMealTicketResponse: envelope('DietaryMealTicket'),
  DietaryMealTicketListResponse: envelope('DietaryMealTicketListData'),
  DietaryKitchenGenerationResponse: envelope('DietaryKitchenGenerationResult'),
  DietaryProductionSummaryResponse: envelope('DietaryProductionSummaryData'),
};

export const operations = {
  'GET /api/v1/dietary/menu-items': {
    description:
      'Tenant menu master list, filterable by meal_type, diet_type (suits-this-diet membership), and active.',
    response: 'DietaryMenuItemListResponse',
  },
  'POST /api/v1/dietary/menu-items': {
    description:
      'Creates a menu item (dietary manager roles: DIETITIAN/ADMIN). One live item per (meal window, name); duplicates 409.',
    request: 'DietaryMenuItemCreateRequest',
    response: 'DietaryMenuItemResponse',
  },
  'PUT /api/v1/dietary/menu-items/{id}': {
    description:
      'Partially updates a menu item (dietary manager roles), including activate/deactivate via active.',
    request: 'DietaryMenuItemUpdateRequest',
    response: 'DietaryMenuItemResponse',
  },
  'GET /api/v1/dietary/kitchen/tickets': {
    description:
      'Kitchen board / ward tray list for a service date (default today IST), filterable by meal_type, status, ward, and patient_uid. Ordered by meal window then ward/bed.',
    response: 'DietaryMealTicketListResponse',
  },
  'GET /api/v1/dietary/kitchen/summary': {
    description:
      'Kitchen production summary for a service date: live-ticket counts by meal x diet type (what the kitchen actually cooks) plus a per-meal status rollup.',
    response: 'DietaryProductionSummaryResponse',
  },
  'POST /api/v1/dietary/kitchen/generate': {
    description:
      "Manually (re)cuts the day's meal tickets for every ACTIVE diet order of a currently admitted patient (kitchen roles). Idempotent: meals already holding a live ticket are skipped; the 05:00 IST scheduler performs the same cut daily.",
    request: 'DietaryKitchenGenerateRequest',
    response: 'DietaryKitchenGenerationResponse',
  },
  'POST /api/v1/dietary/kitchen/tickets/{id}/status': {
    description:
      "Moves a meal ticket through its lifecycle with per-transition role gating: kitchen leg pending→preparing→ready→dispatched and pre-dispatch cancel require a dietary capability role; the ward tray leg dispatched→delivered→collected (and recall-cancel of a dispatched tray) is open to any dietary-mount role. 'delivered' writes the canonical clinical timeline + audit pair in the same transaction.",
    request: 'DietaryMealTicketStatusRequest',
    response: 'DietaryMealTicketResponse',
  },
};
