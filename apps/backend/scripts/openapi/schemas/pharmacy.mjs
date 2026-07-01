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
};

// ---------------------------------------------------------------------------
// Operations — keyed under BOTH mount prefixes (the router is mounted twice).
// Each entry is a [«METHOD /suffix», overlay] pair; aliasOps() fans it out to
// /api/v1/pharmacy-orders AND /api/v1/pharmacy so neither alias falls back to
// the generic Success envelope.
// ---------------------------------------------------------------------------
const OPS = [
  ['GET /catalog', { response: 'PharmacyCatalogListResponse' }],
  ['GET /catalog/{id}/alternatives', { response: 'PharmacyAlternativesResponse' }],
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
