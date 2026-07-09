import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const MODULE_STATUS = new Set(['draft', 'published', 'retired', 'archived']);
const MODULE_TYPES = new Set(['role_manual', 'policy', 'quick_reference', 'safety_brief', 'external_lms_link']);
const CATEGORY_STATUS = new Set(['active', 'hidden', 'archived']);
const TOUR_STATUS = new Set(['draft', 'published', 'retired', 'archived']);
const TOUR_EVENTS = new Set(['started', 'step_viewed', 'skipped', 'completed', 'reset']);
const EVIDENCE_STATUSES = new Set(['captured', 'verified', 'rejected', 'superseded']);
const DEFAULT_CONTROL_CODE = 'TRAINING_COMPLETION';

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function requiredText(value, label, max = 8000) {
  const text = cleanText(value, max);
  if (!text) throw AppError.badRequest(`${label} is required`);
  return text;
}

function safeInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function safeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeMetadata(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be a JSON object');
  }
  return value;
}

function normalizeSteps(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest('steps must be an array');
  return value.slice(0, 50).map((step, index) => ({
    key: cleanText(step?.key, 120) || `step_${index + 1}`,
    label: cleanText(step?.label, 160) || `Step ${index + 1}`,
    target: cleanText(step?.target, 500),
    body: cleanText(step?.body, 1000),
  }));
}

function normalizeRoleList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 80)?.toUpperCase()).filter(Boolean))].slice(0, 80);
}

function normalizeForWire(value) {
  if (value == null) return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForWire);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeForWire(item)]));
  }
  return value;
}

function sqlRoleFilter(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `(
    $2::text IS NULL
    OR cardinality(${prefix}role_scope) = 0
    OR '*' = ANY(${prefix}role_scope)
    OR $2::text = ANY(${prefix}role_scope)
  )`;
}

function roleParam(role) {
  return cleanText(role, 80)?.toUpperCase() || null;
}

function roleAllowed(scope = [], role = null) {
  if (!Array.isArray(scope) || scope.length === 0) return true;
  const normalized = roleParam(role);
  return scope.includes('*') || (normalized ? scope.map((item) => String(item).toUpperCase()).includes(normalized) : false);
}

function publicStatusClause(includeDrafts, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return includeDrafts
    ? `${prefix}status <> 'archived'`
    : `${prefix}status IN ('published', 'active')`;
}

function moduleControlCode(module) {
  return module?.metadata?.nabh_control_code
    || module?.metadata?.control_code
    || (module?.module_type === 'role_manual' ? 'NABH_STAFF_CONFIDENTIALITY_TRAINING' : DEFAULT_CONTROL_CODE);
}

async function findModule(tx, { tenantId, moduleId = null, moduleKey = null }) {
  if (moduleId) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, module_key, title, module_type, category_key, summary,
              content_markdown, content_uri, role_scope, required_for_roles, status,
              version, estimated_minutes, no_phi, effective_from, review_due_on,
              metadata, created_by, updated_by, published_at, created_at, updated_at
         FROM learning_modules
        WHERE tenant_id = $1::uuid AND id = $2
        LIMIT 1`,
      tenantId,
      safeInt(moduleId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER }),
    );
    return rows[0] ? normalizeForWire(rows[0]) : null;
  }
  const key = cleanText(moduleKey, 120);
  if (!key) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, module_key, title, module_type, category_key, summary,
            content_markdown, content_uri, role_scope, required_for_roles, status,
            version, estimated_minutes, no_phi, effective_from, review_due_on,
            metadata, created_by, updated_by, published_at, created_at, updated_at
       FROM learning_modules
      WHERE tenant_id = $1::uuid AND module_key = $2
      LIMIT 1`,
    tenantId,
    key,
  );
  return rows[0] ? normalizeForWire(rows[0]) : null;
}

async function findTour(tx, { tenantId, tourId = null, tourKey = null }) {
  if (tourId) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, tour_key, title, surface, route_pattern, role_scope,
              steps, status, version, resume_policy, metadata, created_by,
              updated_by, published_at, created_at, updated_at
         FROM tour_definitions
        WHERE tenant_id = $1::uuid AND id = $2
        LIMIT 1`,
      tenantId,
      safeInt(tourId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER }),
    );
    return rows[0] ? normalizeForWire(rows[0]) : null;
  }
  const key = cleanText(tourKey, 120);
  if (!key) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, tour_key, title, surface, route_pattern, role_scope,
            steps, status, version, resume_policy, metadata, created_by,
            updated_by, published_at, created_at, updated_at
       FROM tour_definitions
      WHERE tenant_id = $1::uuid AND tour_key = $2
      LIMIT 1`,
    tenantId,
    key,
  );
  return rows[0] ? normalizeForWire(rows[0]) : null;
}

export async function getAdoptionCatalog({ tenantId, role = null, includeDrafts = false } = {}) {
  const tid = requireTenantId(tenantId);
  const roleCode = roleParam(role);
  return setTenant(tid, async (tx) => {
    const categoryRows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, category_key, label, description, parent_category_id,
              role_scope, sort_order, status, metadata, created_by, updated_by,
              created_at, updated_at
         FROM help_center_categories
        WHERE tenant_id = $1::uuid
          AND ${publicStatusClause(includeDrafts)}
          AND ${sqlRoleFilter()}
        ORDER BY sort_order, label`,
      tid,
      roleCode,
    );
    const moduleRows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, module_key, title, module_type, category_key, summary,
              content_markdown, content_uri, role_scope, required_for_roles,
              status, version, estimated_minutes, no_phi, effective_from,
              review_due_on, metadata, created_by, updated_by, published_at,
              created_at, updated_at
         FROM learning_modules
        WHERE tenant_id = $1::uuid
          AND ${publicStatusClause(includeDrafts)}
          AND ${sqlRoleFilter()}
        ORDER BY category_key NULLS LAST, title`,
      tid,
      roleCode,
    );
    const tourRows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, tour_key, title, surface, route_pattern, role_scope,
              steps, status, version, resume_policy, metadata, created_by,
              updated_by, published_at, created_at, updated_at
         FROM tour_definitions
        WHERE tenant_id = $1::uuid
          AND ${publicStatusClause(includeDrafts)}
          AND ${sqlRoleFilter()}
        ORDER BY surface, title`,
      tid,
      roleCode,
    );
    const categories = normalizeForWire(categoryRows);
    const modules = normalizeForWire(moduleRows);
    const tours = normalizeForWire(tourRows);
    return {
      tenant_id: tid,
      role: roleCode,
      categories,
      modules,
      tours,
      counts: {
        categories: categories.length,
        modules: modules.length,
        tours: tours.length,
      },
      invariants: {
        no_phi_training_content: true,
        rich_course_authoring: false,
        evidence_control: 'NABH_STAFF_CONFIDENTIALITY_TRAINING',
      },
    };
  });
}

export async function getAdminAdoptionSummary({ tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  const catalog = await getAdoptionCatalog({ tenantId: tid, role: null, includeDrafts: true });
  return setTenant(tid, async (tx) => {
    const completionRows = await tx.$queryRawUnsafe(
      `SELECT lc.id, lc.tenant_id, lc.module_id, lm.module_key, lm.title,
              lc.actor_uid, lc.actor_role, lc.module_version, lc.status,
              lc.completion_source, lc.completed_at, lc.evidence_metadata
         FROM learning_completions lc
         JOIN learning_modules lm ON lm.id = lc.module_id
        WHERE lc.tenant_id = $1::uuid
        ORDER BY lc.completed_at DESC
        LIMIT 25`,
      tid,
    );
    const tourEventRows = await tx.$queryRawUnsafe(
      `SELECT te.id, te.tenant_id, te.tour_id, td.tour_key, td.title,
              te.actor_uid, te.actor_role, te.tour_version, te.event_type,
              te.step_key, te.metadata, te.created_at
         FROM tour_events te
         JOIN tour_definitions td ON td.id = te.tour_id
        WHERE te.tenant_id = $1::uuid
        ORDER BY te.created_at DESC
        LIMIT 25`,
      tid,
    );
    const evidenceRows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, evidence_key, source_type, source_id, control_code,
              subject_uid, subject_role, title, evidence_status, evidence_uri,
              verified_by, verified_at, period_start, period_end, metadata,
              created_at, updated_at
         FROM training_evidence_ledger
        WHERE tenant_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 50`,
      tid,
    );
    const evidenceCounts = await tx.$queryRawUnsafe(
      `SELECT control_code, evidence_status, COUNT(*)::int AS count
         FROM training_evidence_ledger
        WHERE tenant_id = $1::uuid
        GROUP BY control_code, evidence_status
        ORDER BY control_code, evidence_status`,
      tid,
    );
    const completions = normalizeForWire(completionRows);
    const tourEvents = normalizeForWire(tourEventRows);
    const evidence = normalizeForWire(evidenceRows);
    return {
      ...catalog,
      recent_completions: completions,
      recent_tour_events: tourEvents,
      evidence_ledger: evidence,
      evidence_counts: normalizeForWire(evidenceCounts),
      counts: {
        ...catalog.counts,
        recent_completions: completions.length,
        recent_tour_events: tourEvents.length,
        evidence_rows: evidence.length,
      },
    };
  });
}

export async function upsertHelpCategory({ tenantId, payload = {}, actorUid = null } = {}) {
  const tid = requireTenantId(tenantId);
  const status = cleanText(payload.status, 30) || 'active';
  if (!CATEGORY_STATUS.has(status)) throw AppError.badRequest('Invalid help category status');
  const roleScope = normalizeRoleList(payload.role_scope ?? payload.roleScope);
  const metadata = normalizeMetadata(payload.metadata);
  return setTenant(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO help_center_categories
         (tenant_id, category_key, label, description, role_scope, sort_order,
          status, metadata, created_by, updated_by, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::int, $7, $8::jsonb,
               $9::uuid, $9::uuid, NOW())
       ON CONFLICT (tenant_id, category_key) DO UPDATE SET
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         role_scope = EXCLUDED.role_scope,
         sort_order = EXCLUDED.sort_order,
         status = EXCLUDED.status,
         metadata = help_center_categories.metadata || EXCLUDED.metadata,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING id, tenant_id, category_key, label, description, parent_category_id,
                 role_scope, sort_order, status, metadata, created_by, updated_by,
                 created_at, updated_at`,
      tid,
      requiredText(payload.category_key ?? payload.categoryKey, 'category_key', 100),
      requiredText(payload.label, 'label', 160),
      cleanText(payload.description),
      roleScope,
      safeInt(payload.sort_order ?? payload.sortOrder, 100, { min: 0, max: 10000 }),
      status,
      JSON.stringify(metadata),
      cleanText(actorUid, 80),
    );
    return normalizeForWire(rows[0]);
  });
}

export async function upsertLearningModule({ tenantId, payload = {}, actorUid = null } = {}) {
  const tid = requireTenantId(tenantId);
  const moduleType = cleanText(payload.module_type ?? payload.moduleType, 40) || 'role_manual';
  const status = cleanText(payload.status, 30) || 'draft';
  if (!MODULE_TYPES.has(moduleType)) throw AppError.badRequest('Invalid learning module type');
  if (!MODULE_STATUS.has(status)) throw AppError.badRequest('Invalid learning module status');
  const metadata = normalizeMetadata(payload.metadata);
  const roleScope = normalizeRoleList(payload.role_scope ?? payload.roleScope);
  const requiredForRoles = normalizeRoleList(payload.required_for_roles ?? payload.requiredForRoles);
  return setTenant(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO learning_modules
         (tenant_id, module_key, title, module_type, category_key, summary,
          content_markdown, content_uri, role_scope, required_for_roles, status,
          version, estimated_minutes, no_phi, effective_from, review_due_on,
          metadata, created_by, updated_by, published_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[],
               $11, $12::int, $13::int, TRUE, $14::date, $15::date, $16::jsonb,
               $17::uuid, $17::uuid, CASE WHEN $11 = 'published' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (tenant_id, module_key) DO UPDATE SET
         title = EXCLUDED.title,
         module_type = EXCLUDED.module_type,
         category_key = EXCLUDED.category_key,
         summary = EXCLUDED.summary,
         content_markdown = EXCLUDED.content_markdown,
         content_uri = EXCLUDED.content_uri,
         role_scope = EXCLUDED.role_scope,
         required_for_roles = EXCLUDED.required_for_roles,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         estimated_minutes = EXCLUDED.estimated_minutes,
         no_phi = TRUE,
         effective_from = EXCLUDED.effective_from,
         review_due_on = EXCLUDED.review_due_on,
         metadata = learning_modules.metadata || EXCLUDED.metadata,
         updated_by = EXCLUDED.updated_by,
         published_at = CASE
           WHEN EXCLUDED.status = 'published' THEN COALESCE(learning_modules.published_at, NOW())
           ELSE learning_modules.published_at
         END,
         updated_at = NOW()
       RETURNING id, tenant_id, module_key, title, module_type, category_key, summary,
                 content_markdown, content_uri, role_scope, required_for_roles, status,
                 version, estimated_minutes, no_phi, effective_from, review_due_on,
                 metadata, created_by, updated_by, published_at, created_at, updated_at`,
      tid,
      requiredText(payload.module_key ?? payload.moduleKey, 'module_key', 120),
      requiredText(payload.title, 'title', 180),
      moduleType,
      cleanText(payload.category_key ?? payload.categoryKey, 100),
      cleanText(payload.summary),
      cleanText(payload.content_markdown ?? payload.contentMarkdown, 50000) || '',
      cleanText(payload.content_uri ?? payload.contentUri, 1000),
      roleScope,
      requiredForRoles,
      status,
      safeInt(payload.version, 1, { min: 1, max: 1000 }),
      safeInt(payload.estimated_minutes ?? payload.estimatedMinutes, 5, { min: 1, max: 600 }),
      safeDate(payload.effective_from ?? payload.effectiveFrom),
      safeDate(payload.review_due_on ?? payload.reviewDueOn),
      JSON.stringify(metadata),
      cleanText(actorUid, 80),
    );
    return normalizeForWire(rows[0]);
  });
}

export async function upsertTourDefinition({ tenantId, payload = {}, actorUid = null } = {}) {
  const tid = requireTenantId(tenantId);
  const status = cleanText(payload.status, 30) || 'draft';
  if (!TOUR_STATUS.has(status)) throw AppError.badRequest('Invalid tour status');
  const resumePolicy = cleanText(payload.resume_policy ?? payload.resumePolicy, 30) || 'resume_last_step';
  if (!['restart', 'resume_last_step', 'manual'].includes(resumePolicy)) {
    throw AppError.badRequest('Invalid tour resume policy');
  }
  return setTenant(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO tour_definitions
         (tenant_id, tour_key, title, surface, route_pattern, role_scope, steps,
          status, version, resume_policy, metadata, created_by, updated_by,
          published_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, $9::int,
               $10, $11::jsonb, $12::uuid, $12::uuid,
               CASE WHEN $8 = 'published' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (tenant_id, tour_key) DO UPDATE SET
         title = EXCLUDED.title,
         surface = EXCLUDED.surface,
         route_pattern = EXCLUDED.route_pattern,
         role_scope = EXCLUDED.role_scope,
         steps = EXCLUDED.steps,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         resume_policy = EXCLUDED.resume_policy,
         metadata = tour_definitions.metadata || EXCLUDED.metadata,
         updated_by = EXCLUDED.updated_by,
         published_at = CASE
           WHEN EXCLUDED.status = 'published' THEN COALESCE(tour_definitions.published_at, NOW())
           ELSE tour_definitions.published_at
         END,
         updated_at = NOW()
       RETURNING id, tenant_id, tour_key, title, surface, route_pattern, role_scope,
                 steps, status, version, resume_policy, metadata, created_by,
                 updated_by, published_at, created_at, updated_at`,
      tid,
      requiredText(payload.tour_key ?? payload.tourKey, 'tour_key', 120),
      requiredText(payload.title, 'title', 180),
      requiredText(payload.surface, 'surface', 80),
      cleanText(payload.route_pattern ?? payload.routePattern, 1000),
      normalizeRoleList(payload.role_scope ?? payload.roleScope),
      JSON.stringify(normalizeSteps(payload.steps)),
      status,
      safeInt(payload.version, 1, { min: 1, max: 1000 }),
      resumePolicy,
      JSON.stringify(normalizeMetadata(payload.metadata)),
      cleanText(actorUid, 80),
    );
    return normalizeForWire(rows[0]);
  });
}

export async function recordLearningCompletion({
  tenantId,
  moduleId = null,
  moduleKey = null,
  actorUid,
  actorRole = null,
  assignmentId = null,
  status = 'completed',
  completionSource = 'in_app',
  attestationText = null,
  evidenceMetadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requiredText(actorUid, 'actorUid', 80);
  const cleanStatus = cleanText(status, 30) || 'completed';
  if (!['completed', 'attested', 'waived', 'revoked'].includes(cleanStatus)) {
    throw AppError.badRequest('Invalid learning completion status');
  }
  const source = cleanText(completionSource, 40) || 'in_app';
  return setTenant(tid, async (tx) => {
    const module = await findModule(tx, { tenantId: tid, moduleId, moduleKey });
    if (!module || module.status !== 'published') {
      throw AppError.notFound('Published learning module not found');
    }
    if (!roleAllowed(module.role_scope, actorRole)) {
      throw AppError.forbidden('Learning module is not visible for this role');
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO learning_completions
         (tenant_id, module_id, assignment_id, actor_uid, actor_role, module_version,
          status, completion_source, completed_at, attestation_text, evidence_metadata,
          updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::int, $7, $8, NOW(), $9, $10::jsonb, NOW())
       ON CONFLICT (tenant_id, module_id, actor_uid, module_version) DO UPDATE SET
         assignment_id = COALESCE(EXCLUDED.assignment_id, learning_completions.assignment_id),
         actor_role = EXCLUDED.actor_role,
         status = EXCLUDED.status,
         completion_source = EXCLUDED.completion_source,
         completed_at = CASE
           WHEN EXCLUDED.status IN ('completed', 'attested') THEN NOW()
           ELSE learning_completions.completed_at
         END,
         attestation_text = EXCLUDED.attestation_text,
         evidence_metadata = learning_completions.evidence_metadata || EXCLUDED.evidence_metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, module_id, assignment_id, actor_uid, actor_role,
                 module_version, status, completion_source, completed_at,
                 attestation_text, evidence_metadata, created_at, updated_at`,
      tid,
      module.id,
      assignmentId ? safeInt(assignmentId, null, { min: 1, max: Number.MAX_SAFE_INTEGER }) : null,
      uid,
      cleanText(actorRole, 80),
      module.version,
      cleanStatus,
      source,
      cleanText(attestationText, 4000),
      JSON.stringify(normalizeMetadata(evidenceMetadata)),
    );
    const completion = normalizeForWire(rows[0]);
    const evidence = await upsertTrainingEvidence(tx, {
      tenantId: tid,
      evidenceKey: `learning:${module.id}:${uid}:${module.version}`,
      sourceType: 'learning_completion',
      sourceId: completion.id,
      controlCode: moduleControlCode(module),
      subjectUid: uid,
      subjectRole: actorRole,
      title: module.title,
      evidenceStatus: cleanStatus === 'revoked' ? 'superseded' : 'captured',
      metadata: {
        module_key: module.module_key,
        module_version: module.version,
        completion_source: source,
        ...normalizeMetadata(evidenceMetadata),
      },
    });
    return { completion, evidence };
  });
}

async function upsertTrainingEvidence(tx, {
  tenantId,
  evidenceKey,
  sourceType,
  sourceId,
  controlCode,
  subjectUid,
  subjectRole = null,
  title,
  evidenceStatus = 'captured',
  metadata = {},
}) {
  if (!EVIDENCE_STATUSES.has(evidenceStatus)) throw AppError.badRequest('Invalid evidence status');
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO training_evidence_ledger
       (tenant_id, evidence_key, source_type, source_id, control_code, subject_uid,
        subject_role, title, evidence_status, metadata, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (tenant_id, evidence_key) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       control_code = EXCLUDED.control_code,
       subject_role = EXCLUDED.subject_role,
       title = EXCLUDED.title,
       evidence_status = EXCLUDED.evidence_status,
       metadata = training_evidence_ledger.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, evidence_key, source_type, source_id, control_code,
               subject_uid, subject_role, title, evidence_status, evidence_uri,
               verified_by, verified_at, period_start, period_end, metadata,
               created_at, updated_at`,
    tenantId,
    evidenceKey,
    sourceType,
    sourceId,
    controlCode || DEFAULT_CONTROL_CODE,
    subjectUid,
    cleanText(subjectRole, 80),
    title,
    evidenceStatus,
    JSON.stringify(normalizeMetadata(metadata)),
  );
  return normalizeForWire(rows[0]);
}

export async function recordTourEvent({
  tenantId,
  tourId = null,
  tourKey = null,
  actorUid,
  actorRole = null,
  eventType,
  stepKey = null,
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requiredText(actorUid, 'actorUid', 80);
  const cleanEvent = cleanText(eventType, 30);
  if (!TOUR_EVENTS.has(cleanEvent)) throw AppError.badRequest('Invalid tour event type');
  return setTenant(tid, async (tx) => {
    const tour = await findTour(tx, { tenantId: tid, tourId, tourKey });
    if (!tour || tour.status !== 'published') throw AppError.notFound('Published tour not found');
    if (!roleAllowed(tour.role_scope, actorRole)) {
      throw AppError.forbidden('Tour is not visible for this role');
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO tour_events
         (tenant_id, tour_id, actor_uid, actor_role, tour_version, event_type,
          step_key, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::int, $6, $7, $8::jsonb)
       RETURNING id, tenant_id, tour_id, actor_uid, actor_role, tour_version,
                 event_type, step_key, metadata, created_at`,
      tid,
      tour.id,
      uid,
      cleanText(actorRole, 80),
      tour.version,
      cleanEvent,
      cleanText(stepKey, 120),
      JSON.stringify(normalizeMetadata(metadata)),
    );
    const event = normalizeForWire(rows[0]);
    let evidence = null;
    if (cleanEvent === 'completed') {
      evidence = await upsertTrainingEvidence(tx, {
        tenantId: tid,
        evidenceKey: `tour:${tour.id}:${uid}:${tour.version}`,
        sourceType: 'tour_completion',
        sourceId: event.id,
        controlCode: tour.metadata?.control_code || 'VH_TOUR_COMPLETION',
        subjectUid: uid,
        subjectRole: actorRole,
        title: tour.title,
        metadata: {
          tour_key: tour.tour_key,
          tour_version: tour.version,
          surface: tour.surface,
          ...normalizeMetadata(metadata),
        },
      });
    }
    return { event, evidence };
  });
}

export async function listTrainingEvidence({
  tenantId,
  controlCode = null,
  status = null,
  from = null,
  to = null,
  limit = 200,
} = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (controlCode) {
    params.push(cleanText(controlCode, 100));
    filters.push(`control_code = $${params.length}`);
  }
  if (status) {
    const cleanStatus = cleanText(status, 30);
    if (!EVIDENCE_STATUSES.has(cleanStatus)) throw AppError.badRequest('Invalid evidence status');
    params.push(cleanStatus);
    filters.push(`evidence_status = $${params.length}`);
  }
  if (from) {
    params.push(from);
    filters.push(`created_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    filters.push(`created_at < ($${params.length}::date + 1)`);
  }
  params.push(safeInt(limit, 200, { min: 1, max: 1000 }));
  return setTenant(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, evidence_key, source_type, source_id, control_code,
              subject_uid, subject_role, title, evidence_status, evidence_uri,
              verified_by, verified_at, period_start, period_end, metadata,
              created_at, updated_at
         FROM training_evidence_ledger
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${params.length}::int`,
      ...params,
    );
    const evidence = normalizeForWire(rows);
    return { evidence, count: evidence.length };
  });
}

export function trainingEvidenceToCsv(rows = []) {
  const header = [
    'evidence_key',
    'control_code',
    'source_type',
    'subject_uid',
    'subject_role',
    'title',
    'evidence_status',
    'created_at',
    'verified_at',
    'evidence_uri',
  ];
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = rows.map((row) => header.map((key) => escape(row[key])).join(','));
  return [header.join(','), ...lines].join('\n');
}

export const __testing__ = {
  normalizeRoleList,
  normalizeForWire,
  trainingEvidenceToCsv,
};

export default {
  getAdoptionCatalog,
  getAdminAdoptionSummary,
  listTrainingEvidence,
  recordLearningCompletion,
  recordTourEvent,
  trainingEvidenceToCsv,
  upsertHelpCategory,
  upsertLearningModule,
  upsertTourDefinition,
};
