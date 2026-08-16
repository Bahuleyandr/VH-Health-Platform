// src/services/dietary/kitchenService.js
//
// Kitchen management on top of diet orders (migration 685): tenant menu
// master, per-meal kitchen production tickets, and ward-side tray tracking.
//
// Generation model (documented decision):
//   - The scheduler cuts the whole day's tickets once per tenant at 05:00 IST
//     ('dietary-meal-ticket-generation', cron 30 23 * * * UTC) — before the
//     breakfast line starts. One daily cut, not one per meal window: the
//     kitchen plans the full day from the morning production summary, and
//     same-day churn is handled by the two re-sync paths below rather than by
//     more cron ticks.
//   - Same-day diet-order changes re-sync synchronously (best-effort Phase
//     1.5 from dietaryService create/update): still-pending tickets for the
//     changed order are cancelled ('diet order changed') and the day is
//     re-cut for whatever meals lack a live ticket. Tickets already
//     preparing/ready/dispatched are left alone — the tray is already in
//     flight; the kitchen cancels manually if needed.
//   - Allergen screening (migration 687): menu selection screens against the
//     UNION of the platform's canonical allergy answer
//     (getUnifiedActiveAllergiesDetailed — all four allergy stores) and the
//     diet order's free-text allergies/restrictions. diet_orders.allergies
//     alone is NOT sufficient: no first-party client writes it. Matching
//     errs toward exclusion (bidirectional substring + curated food-allergen
//     class synonyms), a degraded screen (any unified source failed) fails
//     CLOSED by excluding every allergen-tagged item, and the screen
//     evidence persists on the ticket (allergy_screen, the
//     radiology contrast_allergy_screen idiom).
//   - POST /dietary/kitchen/generate re-runs generation manually (new
//     admissions after the morning cut, or a missed scheduler tick).
//     Generation is idempotent: the live-uniqueness index absorbs re-runs.
//   - Eligibility: ACTIVE diet orders of currently admitted patients
//     (admissions.status = 'admitted' AND discharged_at IS NULL), excluding
//     'npo' (nil by mouth). All four meal windows are cut for every eligible
//     order — diabetic/renal days include snacks; the kitchen cancels a
//     window it will not serve.
//
// Canonical timeline: exactly one clinical_timeline_events +
// clinical_audit_events pair per ticket, emitted at 'delivered' (the
// patient-facing fact: this meal reached this admitted patient) in the same
// transaction as the transition, fixed key
// dietary_meal_tickets:<id>:delivered (insert-once — delivered is reachable
// once per ticket). Bulk generation deliberately does not write per-ticket
// timeline rows (aggregate-noise class); the ticket row itself is the
// generation evidence. No workflow_sla_instances: no meal-service SLA rule
// class exists and this wave does not invent one.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { istDateString } from '../../utils/dateUtils.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getUnifiedActiveAllergiesDetailed } from '../clinical/allergySourceService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  SUPER_ADMIN, ADMIN, DIETITIAN, DIETARY_STAFF, hasRole,
} from '../../utils/roles.js';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// diet_orders.diet_type vocabulary minus 'npo' — nothing by mouth gets no
// menu item and no ticket.
export const MENU_DIET_TYPES = [
  'regular', 'diabetic', 'cardiac', 'renal', 'soft', 'liquid', 'enteral',
];

export const TICKET_STATUSES = [
  'pending', 'preparing', 'ready', 'dispatched', 'delivered', 'collected', 'cancelled',
];

// Service-enforced lifecycle. pending→dispatched is the kitchen leg;
// dispatched→delivered→collected is ward-side tray tracking.
export const TICKET_TRANSITIONS = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['dispatched', 'cancelled'],
  dispatched: ['delivered', 'cancelled'],
  delivered: ['collected'],
  collected: [],
  cancelled: [],
};

// Kitchen-phase actions (progressing the production line, cancelling before
// the tray leaves the kitchen, cutting tickets, editing the menu master's
// read side) belong to the dietary capability roles. The delivered/collected
// leg — and recalling a dispatched tray — is open to every role the
// /api/v1/dietary mount admits (ward/clinical staff included).
export const KITCHEN_ROLES = [SUPER_ADMIN, ADMIN, DIETITIAN, DIETARY_STAFF];
// Menu master mutations are manager-gated: line kitchen staff cook from the
// menu, they do not edit it.
export const MENU_MANAGE_ROLES = [SUPER_ADMIN, ADMIN, DIETITIAN];

const TICKET_SELECT = `
  id::text AS id, tenant_id, diet_order_id, patient_uid, service_date::text AS service_date,
  meal_type, admission_id, ward, bed_number, patient_name, diet_type,
  restrictions, allergies, calories_target, menu_selections, diet_spec,
  special_instructions, allergy_screen, status, generated_source, generated_by,
  preparing_at, ready_at, dispatched_at, delivered_at, collected_at,
  cancelled_at, cancelled_by, cancel_reason, created_at, updated_at`;

const MENU_ITEM_SELECT = `
  id::text AS id, tenant_id, name, meal_type, diet_types, is_veg,
  allergen_tags, active, notes, created_by, created_at, updated_at`;

function tenantOr(value) {
  return requireTenantId(String(value || '').trim() || null);
}

const toTextArray = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,\n;]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
};

const lowerSet = (arr) => new Set((arr || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean));

function normalizeServiceDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return istDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw AppError.badRequest('service_date must be YYYY-MM-DD');
  }
  return raw;
}

function isUniqueViolation(err) {
  return err?.meta?.code === '23505'
    || err?.code === '23505'
    || /23505|duplicate key value/i.test(String(err?.message || ''));
}

// ---------------------------------------------------------------------------
// Menu master
// ---------------------------------------------------------------------------

function validateMenuFields({ meal_type, diet_types }) {
  if (meal_type != null && !MEAL_TYPES.includes(meal_type)) {
    throw AppError.badRequest(`Invalid meal_type. Must be one of: ${MEAL_TYPES.join(', ')}`);
  }
  if (diet_types != null) {
    const bad = diet_types.filter((d) => !MENU_DIET_TYPES.includes(d));
    if (bad.length) {
      throw AppError.badRequest(
        `Invalid diet_types: ${bad.join(', ')}. Must be a subset of: ${MENU_DIET_TYPES.join(', ')}`,
      );
    }
  }
}

export async function createMenuItem(data = {}) {
  const tenantId = tenantOr(data.tenant_id || data.tenantId);
  const name = String(data.name || '').trim();
  const mealType = data.meal_type;
  if (!name || !mealType) {
    throw AppError.badRequest('Missing required fields: name, meal_type');
  }
  const dietTypes = toTextArray(data.diet_types).map((d) => d.toLowerCase());
  validateMenuFields({ meal_type: mealType, diet_types: dietTypes });
  const allergenTags = toTextArray(data.allergen_tags).map((t) => t.toLowerCase());

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO dietary_menu_items
         (tenant_id, name, meal_type, diet_types, is_veg, allergen_tags, active, notes, created_by)
       VALUES ($1::uuid, $2, $3, $4::text[], $5::boolean, $6::text[], TRUE, $7, $8::uuid)
       RETURNING ${MENU_ITEM_SELECT}`,
      tenantId, name, mealType, dietTypes,
      data.is_veg !== false, allergenTags,
      data.notes || null, data.created_by || null,
    );
    logger.info('Dietary menu item created', { tenantId, id: rows[0].id, name, mealType });
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'An active menu item with this name already exists for this meal',
        'DIETARY_MENU_ITEM_DUPLICATE',
      );
    }
    throw err;
  }
}

export async function updateMenuItem(id, data = {}) {
  const tenantId = tenantOr(data.tenant_id || data.tenantId);
  const itemId = Number.parseInt(id, 10);
  if (!Number.isInteger(itemId) || itemId <= 0) throw AppError.badRequest('Invalid menu item id');

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id FROM dietary_menu_items
      WHERE tenant_id = $1::uuid AND id = $2::bigint LIMIT 1`,
    tenantId, itemId,
  );
  if (!existing.length) throw AppError.notFound('Menu item not found');

  const sets = [];
  const params = [tenantId, itemId];
  const push = (fragment, value) => {
    params.push(value);
    sets.push(fragment.replace('?', `$${params.length}`));
  };

  if (data.name != null) {
    const name = String(data.name).trim();
    if (!name) throw AppError.badRequest('name cannot be empty');
    push('name = ?', name);
  }
  if (data.meal_type != null) {
    validateMenuFields({ meal_type: data.meal_type });
    push('meal_type = ?', data.meal_type);
  }
  if (data.diet_types !== undefined) {
    const dietTypes = toTextArray(data.diet_types).map((d) => d.toLowerCase());
    validateMenuFields({ diet_types: dietTypes });
    push('diet_types = ?::text[]', dietTypes);
  }
  if (data.is_veg != null) push('is_veg = ?::boolean', data.is_veg === true);
  if (data.allergen_tags !== undefined) {
    push('allergen_tags = ?::text[]', toTextArray(data.allergen_tags).map((t) => t.toLowerCase()));
  }
  if (data.active != null) push('active = ?::boolean', data.active === true);
  if (data.notes !== undefined) push('notes = ?', data.notes || null);

  if (!sets.length) throw AppError.badRequest('No fields to update');
  sets.push('updated_at = NOW()');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE dietary_menu_items SET ${sets.join(', ')}
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING ${MENU_ITEM_SELECT}`,
      ...params,
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'An active menu item with this name already exists for this meal',
        'DIETARY_MENU_ITEM_DUPLICATE',
      );
    }
    throw err;
  }
}

export async function listMenuItems(filters = {}) {
  const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
  const conditions = ['tenant_id = $1::uuid'];
  const params = [tenantId];

  if (filters.meal_type) {
    validateMenuFields({ meal_type: filters.meal_type });
    params.push(filters.meal_type);
    conditions.push(`meal_type = $${params.length}`);
  }
  if (filters.diet_type) {
    params.push(filters.diet_type);
    conditions.push(`$${params.length} = ANY(diet_types)`);
  }
  if (filters.active === 'true' || filters.active === true) conditions.push('active');
  else if (filters.active === 'false' || filters.active === false) conditions.push('NOT active');

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${MENU_ITEM_SELECT}
       FROM dietary_menu_items
      WHERE ${conditions.join(' AND ')}
      ORDER BY meal_type, lower(name)`,
    ...params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Allergen screening (migration 687)
// ---------------------------------------------------------------------------

const lower = (value) => String(value ?? '').trim().toLowerCase();

// Curated food-allergen synonym classes, the CONTRAST_AGENTS idiom from
// utils/clinical/contrastAllergyCheck.js: free-text allergy stores and menu
// allergen tags rarely use the same word, so exact/substring matching alone
// misses "dairy" vs a 'milk' tag. India-first vocabulary (paneer, til,
// maida…). Matching errs toward exclusion — a false exclusion costs a menu
// choice, a false pass serves an allergen.
export const FOOD_ALLERGEN_CLASSES = {
  peanut: ['peanut', 'groundnut', 'arachis', 'moongphali'],
  milk: ['milk', 'dairy', 'lactose', 'casein', 'whey', 'paneer', 'curd',
    'yogurt', 'yoghurt', 'ghee', 'butter', 'cheese', 'cream', 'khoya', 'dahi'],
  egg: ['egg', 'albumin', 'anda'],
  gluten: ['gluten', 'wheat', 'maida', 'atta', 'suji', 'sooji', 'semolina',
    'rava', 'barley', 'rye', 'gehu'],
  soy: ['soy', 'soya', 'soybean'],
  fish: ['fish', 'anchovy', 'sardine', 'mackerel', 'salmon', 'tuna', 'machli'],
  shellfish: ['shellfish', 'prawn', 'shrimp', 'crab', 'lobster', 'crustacean',
    'oyster', 'clam', 'mussel', 'squid'],
  tree_nut: ['tree nut', 'treenut', 'nut', 'almond', 'cashew', 'walnut',
    'pistachio', 'hazelnut', 'pecan', 'macadamia', 'badam', 'kaju', 'akhrot'],
  sesame: ['sesame', 'til', 'gingelly', 'tahini'],
  mustard: ['mustard', 'sarson'],
};

// Terms shorter than this are too degenerate for substring/class matching
// ("e" would exclude everything); real allergen words are >= 3 chars.
const MIN_MATCH_TERM_LENGTH = 3;

function allergenClassesOf(text) {
  const value = lower(text);
  if (value.length < MIN_MATCH_TERM_LENGTH) return [];
  return Object.entries(FOOD_ALLERGEN_CLASSES)
    .filter(([, aliases]) => aliases.some(
      (alias) => value.includes(alias) || alias.includes(value),
    ))
    .map(([klass]) => klass);
}

/**
 * Collect the patient's allergen terms for menu matching: the unified-store
 * allergen names plus the diet order's free-text allergies AND restrictions
 * (a "no nuts" restriction must exclude nut-tagged items). Pure — exported
 * for unit tests.
 */
export function buildAllergenTerms({
  unifiedAllergies = [], orderAllergies = [], orderRestrictions = [],
} = {}) {
  const terms = new Set();
  for (const allergy of unifiedAllergies) {
    const term = lower(allergy?.allergen);
    if (term.length >= MIN_MATCH_TERM_LENGTH) terms.add(term);
  }
  for (const value of [...(orderAllergies || []), ...(orderRestrictions || [])]) {
    const term = lower(value);
    if (term.length >= MIN_MATCH_TERM_LENGTH) terms.add(term);
  }
  return [...terms];
}

/**
 * Does a menu item's allergen tagging conflict with the patient's allergen
 * terms? Bidirectional substring (the prescription/contrast gate rule) plus
 * shared food-allergen class. A DEGRADED screen (an allergy source failed —
 * the union may be incomplete) fails closed: every allergen-tagged item is
 * excluded. Pure — exported for unit tests.
 *
 * @returns {{ tag:string, matched:string|null, via:string }|null}
 */
export function menuItemAllergenConflict(item, terms, { degraded = false } = {}) {
  const tags = (item?.allergen_tags || []).map(lower).filter(Boolean);
  if (!tags.length) return null;
  if (degraded) return { tag: tags[0], matched: null, via: 'screen_degraded' };
  for (const tag of tags) {
    for (const term of terms || []) {
      if (tag.includes(term) || term.includes(tag)) {
        return { tag, matched: term, via: 'substring' };
      }
      const shared = allergenClassesOf(tag).filter(
        (klass) => allergenClassesOf(term).includes(klass),
      );
      if (shared.length) return { tag, matched: term, via: `class:${shared[0]}` };
    }
  }
  return null;
}

/**
 * Screen one meal window's menu against a diet type + allergen terms.
 * Pure — exported for unit tests.
 *
 * @returns {{ selections:Array, excluded:Array }} excluded carries the
 *   per-item evidence ({ id, name, tag, matched, via }) persisted into
 *   allergy_screen.
 */
export function screenMenuItems(menuItems, {
  mealType, dietType, terms = [], degraded = false,
} = {}) {
  const selections = [];
  const excluded = [];
  for (const item of menuItems || []) {
    if (item.meal_type !== mealType || !(item.diet_types || []).includes(dietType)) continue;
    const conflict = menuItemAllergenConflict(item, terms, { degraded });
    if (conflict) {
      excluded.push({ id: Number(item.id), name: item.name, ...conflict });
    } else {
      selections.push({ id: Number(item.id), name: item.name, is_veg: item.is_veg });
    }
  }
  return { selections, excluded };
}

/**
 * Resolve the full allergy picture for one diet order's patient: the unified
 * four-store answer + the order's own free text. Never throws — a failed
 * unified lookup degrades the screen, which then fails CLOSED at matching.
 */
async function loadOrderAllergyContext(order, { db = prisma } = {}) {
  const orderAllergies = order.allergies || [];
  const orderRestrictions = order.restrictions || [];
  let unified = [];
  let sourcesFailed = [];
  let degraded = false;
  try {
    const detailed = await getUnifiedActiveAllergiesDetailed(db, {
      patientUid: order.patient_uid,
    });
    unified = detailed.allergies || [];
    sourcesFailed = detailed.sourcesFailed || [];
    degraded = sourcesFailed.length > 0 || !detailed.patientResolved;
  } catch (err) {
    degraded = true;
    sourcesFailed = ['unified_lookup'];
    logger.warn('Dietary allergy screen: unified allergy lookup failed — failing closed', {
      dietOrderId: order.id, error: err?.message,
    });
  }

  // Ticket snapshot: unified names + order free-text, deduped
  // case-insensitively with original casing kept, so kitchen staff see the
  // whole allergy picture on the ticket.
  const allergyNames = [];
  const seen = new Set();
  for (const name of [...unified.map((a) => a.allergen), ...orderAllergies]) {
    const key = lower(name);
    if (key && !seen.has(key)) {
      seen.add(key);
      allergyNames.push(String(name).trim());
    }
  }

  return {
    allergyNames,
    terms: buildAllergenTerms({
      unifiedAllergies: unified, orderAllergies, orderRestrictions,
    }),
    degraded,
    sourcesFailed,
    orderAllergies,
    orderRestrictions,
  };
}

// Evidence blob persisted to dietary_meal_tickets.allergy_screen — the
// radiology contrast_allergy_screen idiom: the immutable record of what the
// screen knew when the ticket was cut.
function buildAllergyScreenEvidence(ctx, excluded) {
  return {
    screened_at: new Date().toISOString(),
    degraded: ctx.degraded,
    sources_failed: ctx.sourcesFailed,
    patient_allergies: ctx.allergyNames,
    order_allergies: ctx.orderAllergies,
    order_restrictions: ctx.orderRestrictions,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Ticket generation
// ---------------------------------------------------------------------------

/**
 * Cut meal tickets for every ACTIVE diet order of a currently admitted
 * patient (optionally scoped to one diet order). Idempotent: the live
 * (diet_order, service_date, meal_type) unique index absorbs re-runs via
 * ON CONFLICT DO NOTHING.
 *
 * @returns {{ serviceDate:string, considered:number, created:number, byMeal:Object }}
 */
export async function generateMealTickets({
  tenantId: rawTenantId,
  serviceDate = null,
  source = 'scheduler',
  generatedBy = null,
  dietOrderId = null,
} = {}) {
  const tenantId = tenantOr(rawTenantId);
  const date = normalizeServiceDate(serviceDate);
  if (!['scheduler', 'manual', 'order_change'].includes(source)) {
    throw AppError.badRequest('Invalid generation source');
  }

  const orderScope = dietOrderId != null ? Number.parseInt(dietOrderId, 10) : null;
  if (dietOrderId != null && (!Number.isInteger(orderScope) || orderScope <= 0)) {
    throw AppError.badRequest('Invalid diet_order_id');
  }

  const params = [tenantId];
  let scopeClause = '';
  if (orderScope != null) {
    params.push(orderScope);
    scopeClause = `AND o.id = $${params.length}`;
  }

  // Eligible orders joined honestly to a live admission: status 'admitted'
  // AND not discharged (the house "currently admitted" predicate). DISTINCT
  // ON keeps the newest live admission if data ever holds more than one.
  const orders = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (o.id)
            o.id, o.patient_uid, o.diet_type, o.restrictions, o.allergies,
            o.meal_preferences, o.calories_target, o.special_instructions,
            a.id AS admission_id, a.ward, a.bed_number,
            u.name AS patient_name
       FROM diet_orders o
       JOIN admissions a
         ON a.patient_uid = o.patient_uid
        AND a.tenant_id = o.tenant_id
        AND a.status = 'admitted'
        AND a.discharged_at IS NULL
       JOIN users u ON u.uid = o.patient_uid AND u.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1::uuid
        AND o.status = 'active'
        AND o.diet_type <> 'npo'
        ${scopeClause}
      ORDER BY o.id, a.admitted_at DESC NULLS LAST, a.id DESC`,
    ...params,
  );

  if (!orders.length) {
    return { serviceDate: date, considered: 0, created: 0, byMeal: {} };
  }

  const menuItems = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id, name, meal_type, diet_types, is_veg, allergen_tags
       FROM dietary_menu_items
      WHERE tenant_id = $1::uuid AND active`,
    tenantId,
  );

  let created = 0;
  const byMeal = {};
  for (const order of orders) {
    // One unified-allergy resolution per order (not per meal); a degraded
    // screen fails closed inside screenMenuItems.
    const allergyCtx = await loadOrderAllergyContext(order);
    for (const mealType of MEAL_TYPES) {
      const { selections, excluded } = screenMenuItems(menuItems, {
        mealType,
        dietType: order.diet_type,
        terms: allergyCtx.terms,
        degraded: allergyCtx.degraded,
      });
      let dietSpec = null;
      if (!selections.length) {
        dietSpec = `${order.diet_type} diet — no matching menu item; prepare per diet spec`
          + (order.meal_preferences ? `; preference: ${order.meal_preferences}` : '');
        if (excluded.length) {
          dietSpec += allergyCtx.degraded
            ? `; ${excluded.length} menu item(s) withheld — allergy screen degraded, verify patient allergies before preparing`
            : `; ${excluded.length} menu item(s) withheld on allergen match`;
        }
      }
      const allergyScreen = buildAllergyScreenEvidence(allergyCtx, excluded);

      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO dietary_meal_tickets
           (tenant_id, diet_order_id, patient_uid, service_date, meal_type,
            admission_id, ward, bed_number, patient_name, diet_type,
            restrictions, allergies, calories_target, menu_selections,
            diet_spec, special_instructions, allergy_screen,
            generated_source, generated_by)
         VALUES ($1::uuid, $2::int, $3::uuid, $4::date, $5,
                 $6::int, $7, $8, $9, $10,
                 $11::text[], $12::text[], $13::numeric, $14::jsonb,
                 $15, $16, $17::jsonb, $18, $19::uuid)
         ON CONFLICT DO NOTHING
         RETURNING id::text AS id`,
        tenantId, order.id, order.patient_uid, date, mealType,
        order.admission_id, order.ward || null, order.bed_number || null,
        order.patient_name || null, order.diet_type,
        order.restrictions || [], allergyCtx.allergyNames,
        order.calories_target ?? null, JSON.stringify(selections),
        dietSpec, order.special_instructions || null, JSON.stringify(allergyScreen),
        source, generatedBy || null,
      );
      if (rows.length) {
        created += 1;
        byMeal[mealType] = (byMeal[mealType] || 0) + 1;
      }
    }
  }

  if (created > 0) {
    logger.info('Dietary meal tickets generated', {
      tenantId, serviceDate: date, source, considered: orders.length, created,
    });
  }
  return { serviceDate: date, considered: orders.length, created, byMeal };
}

/**
 * Same-day re-sync after a diet-order create/change: cancel today's
 * still-pending tickets for the order (the kitchen has not started them),
 * then re-cut whatever meals lack a live ticket if the order is still
 * eligible. Tickets already preparing or later are left in flight.
 */
export async function syncTicketsForOrder({
  tenantId: rawTenantId,
  dietOrderId,
  actorUid = null,
  reason = 'diet order changed',
} = {}) {
  const tenantId = tenantOr(rawTenantId);
  const orderId = Number.parseInt(dietOrderId, 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw AppError.badRequest('Invalid diet_order_id');
  }
  const date = istDateString();

  const cancelled = await prisma.$queryRawUnsafe(
    `UPDATE dietary_meal_tickets
        SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3::uuid,
            cancel_reason = $4, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND diet_order_id = $2::int
        AND service_date = $5::date AND status = 'pending'
      RETURNING id::text AS id`,
    tenantId, orderId, actorUid || null, reason, date,
  );

  const generation = await generateMealTickets({
    tenantId, serviceDate: date, source: 'order_change', generatedBy: actorUid, dietOrderId: orderId,
  });

  return { serviceDate: date, cancelled: cancelled.length, created: generation.created };
}

// ---------------------------------------------------------------------------
// Ticket board / transitions / production summary
// ---------------------------------------------------------------------------

export async function listMealTickets(filters = {}) {
  const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
  const date = normalizeServiceDate(filters.service_date || filters.date);
  const conditions = ['tenant_id = $1::uuid', 'service_date = $2::date'];
  const params = [tenantId, date];

  if (filters.meal_type) {
    if (!MEAL_TYPES.includes(filters.meal_type)) {
      throw AppError.badRequest(`Invalid meal_type. Must be one of: ${MEAL_TYPES.join(', ')}`);
    }
    params.push(filters.meal_type);
    conditions.push(`meal_type = $${params.length}`);
  }
  if (filters.status) {
    if (!TICKET_STATUSES.includes(filters.status)) {
      throw AppError.badRequest(`Invalid status. Must be one of: ${TICKET_STATUSES.join(', ')}`);
    }
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.ward) {
    params.push(filters.ward);
    conditions.push(`ward = $${params.length}`);
  }
  if (filters.patient_uid) {
    params.push(filters.patient_uid);
    conditions.push(`patient_uid = $${params.length}::uuid`);
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${TICKET_SELECT}
       FROM dietary_meal_tickets
      WHERE ${conditions.join(' AND ')}
      ORDER BY array_position(ARRAY['breakfast','lunch','dinner','snack']::text[], meal_type),
               ward NULLS LAST, bed_number NULLS LAST, id`,
    ...params,
  );
  return { serviceDate: date, tickets: rows };
}

/**
 * What the kitchen cooks today: live-ticket counts by meal x diet type, plus
 * a status rollup per meal for the board header.
 */
export async function getProductionSummary(filters = {}) {
  const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
  const date = normalizeServiceDate(filters.service_date || filters.date);

  const production = await prisma.$queryRawUnsafe(
    `SELECT meal_type, diet_type, COUNT(*)::int AS count
       FROM dietary_meal_tickets
      WHERE tenant_id = $1::uuid AND service_date = $2::date AND status <> 'cancelled'
      GROUP BY meal_type, diet_type
      ORDER BY array_position(ARRAY['breakfast','lunch','dinner','snack']::text[], meal_type), diet_type`,
    tenantId, date,
  );
  const statuses = await prisma.$queryRawUnsafe(
    `SELECT meal_type, status, COUNT(*)::int AS count
       FROM dietary_meal_tickets
      WHERE tenant_id = $1::uuid AND service_date = $2::date
      GROUP BY meal_type, status`,
    tenantId, date,
  );

  const byMeal = {};
  for (const mealType of MEAL_TYPES) {
    byMeal[mealType] = { total: 0, by_diet_type: {}, by_status: {} };
  }
  for (const row of production) {
    const meal = byMeal[row.meal_type];
    if (!meal) continue;
    meal.total += row.count;
    meal.by_diet_type[row.diet_type] = row.count;
  }
  for (const row of statuses) {
    const meal = byMeal[row.meal_type];
    if (!meal) continue;
    meal.by_status[row.status] = row.count;
  }
  const totalLive = production.reduce((sum, row) => sum + row.count, 0);

  return { serviceDate: date, totalLive, byMeal };
}

const KITCHEN_TARGETS = new Set(['preparing', 'ready', 'dispatched']);
const STAMPED = {
  preparing: ['preparing_at', 'preparing_by'],
  ready: ['ready_at', 'ready_by'],
  dispatched: ['dispatched_at', 'dispatched_by'],
  delivered: ['delivered_at', 'delivered_by'],
  collected: ['collected_at', 'collected_by'],
};

/**
 * Move one ticket through its lifecycle with actor + role validation.
 * Kitchen-phase actions (→preparing/ready/dispatched, and cancelling before
 * dispatch) require a dietary capability role; the ward tray leg
 * (→delivered/collected, recall-cancel of a dispatched tray) is open to any
 * role the dietary mount admits. 'delivered' emits the canonical timeline +
 * audit pair in the same transaction.
 */
export async function transitionTicket({
  tenantId: rawTenantId,
  ticketId,
  toStatus,
  actor = null,
  reason = null,
} = {}) {
  const tenantId = tenantOr(rawTenantId);
  const id = Number.parseInt(ticketId, 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid ticket id');
  if (!TICKET_STATUSES.includes(toStatus)) {
    throw AppError.badRequest(`Invalid status. Must be one of: ${TICKET_STATUSES.join(', ')}`);
  }
  const actorUid = actor?.uid || null;
  if (!actorUid) throw AppError.badRequest('Missing acting user');
  if (toStatus === 'cancelled' && !String(reason || '').trim()) {
    throw AppError.badRequest('cancel requires a reason');
  }

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id::text AS id, status, patient_uid, meal_type, diet_type,
              service_date::text AS service_date, ward, bed_number, patient_name
         FROM dietary_meal_tickets
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        FOR UPDATE`,
      tenantId, id,
    );
    if (!rows.length) throw AppError.notFound('Meal ticket not found');
    const ticket = rows[0];

    const allowed = TICKET_TRANSITIONS[ticket.status] || [];
    if (!allowed.includes(toStatus)) {
      throw AppError.invalidTransition(ticket.status, toStatus, allowed);
    }

    const kitchenPhase = KITCHEN_TARGETS.has(toStatus)
      || (toStatus === 'cancelled' && ticket.status !== 'dispatched');
    if (kitchenPhase && !hasRole(actor, KITCHEN_ROLES)) {
      throw AppError.forbidden('Kitchen (dietary) role required for this transition');
    }

    const sets = ['status = $3', 'updated_at = NOW()'];
    const params = [tenantId, id, toStatus, actorUid];
    if (toStatus === 'cancelled') {
      params.push(String(reason).trim());
      sets.push('cancelled_at = NOW()', 'cancelled_by = $4::uuid', `cancel_reason = $${params.length}`);
    } else {
      const [atCol, byCol] = STAMPED[toStatus];
      sets.push(`${atCol} = NOW()`, `${byCol} = $4::uuid`);
    }

    const updated = await tx.$queryRawUnsafe(
      `UPDATE dietary_meal_tickets SET ${sets.join(', ')}
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING ${TICKET_SELECT}`,
      ...params,
    );

    if (toStatus === 'delivered') {
      const mealLabel = ticket.meal_type.charAt(0).toUpperCase() + ticket.meal_type.slice(1);
      await recordCanonicalClinicalEvent({
        tenantId,
        patientUid: ticket.patient_uid,
        eventType: 'dietary.meal_delivered',
        eventStatus: 'delivered',
        sourceTable: 'dietary_meal_tickets',
        sourceId: String(id),
        resourceType: 'dietary_meal_ticket',
        resourceId: String(id),
        actorUid,
        actorRole: actor?.role || null,
        summary: `${mealLabel} tray delivered (${ticket.diet_type} diet)`,
        payload: {
          ticket_id: Number(id),
          service_date: ticket.service_date,
          meal_type: ticket.meal_type,
          diet_type: ticket.diet_type,
          ward: ticket.ward || null,
          bed_number: ticket.bed_number || null,
        },
        tags: ['dietary'],
        timelineIdempotencyKey: `dietary_meal_tickets:${id}:delivered`,
        auditIdempotencyKey: `dietary_meal_tickets:${id}:audit:delivered`,
      }, { db: tx });
    }

    logger.info('Dietary meal ticket transition', {
      tenantId, ticketId: id, from: ticket.status, to: toStatus, actorUid,
    });
    return updated[0];
  });
}

export default {
  MEAL_TYPES,
  MENU_DIET_TYPES,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  KITCHEN_ROLES,
  MENU_MANAGE_ROLES,
  FOOD_ALLERGEN_CLASSES,
  buildAllergenTerms,
  menuItemAllergenConflict,
  screenMenuItems,
  createMenuItem,
  updateMenuItem,
  listMenuItems,
  generateMealTickets,
  syncTicketsForOrder,
  listMealTickets,
  getProductionSummary,
  transitionTicket,
};
