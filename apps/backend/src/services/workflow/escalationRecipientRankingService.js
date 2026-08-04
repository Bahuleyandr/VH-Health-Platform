import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

export const DEFAULT_PRESENCE_WINDOW_MINUTES = 720;
export const MIN_PRESENCE_WINDOW_MINUTES = 15;
export const MAX_PRESENCE_WINDOW_MINUTES = 2880;
export const MAX_RANK_MAPPINGS = 500;

const SOURCE_KINDS = new Set(['position', 'designation']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeEscalationRankLabel(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function displayLabel(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

function normalizeActorUid(value) {
  const actor = String(value ?? '').trim();
  return UUID_RE.test(actor) ? actor.toLowerCase() : null;
}

function rankingControl(settings) {
  const raw = settings && typeof settings === 'object'
    ? settings.escalation_recipient_ranking
    : null;
  if (!raw || typeof raw !== 'object' || raw.configured !== true) {
    return {
      configured: false,
      explicitEmpty: false,
      revision: 0,
      presenceWindowMinutes: DEFAULT_PRESENCE_WINDOW_MINUTES,
      expectedMappingCount: 0,
      lastReplacedAt: null,
      lastReplacedBy: null,
    };
  }
  const expectedMappingCount = Number.isInteger(Number(raw.expected_mapping_count))
    ? Math.max(0, Number(raw.expected_mapping_count))
    : 0;
  const presenceWindowMinutes = Number(raw.presence_window_minutes);
  return {
    configured: true,
    explicitEmpty: expectedMappingCount === 0,
    revision: Math.max(1, Number.parseInt(raw.revision, 10) || 1),
    presenceWindowMinutes: Number.isInteger(presenceWindowMinutes)
      ? presenceWindowMinutes
      : DEFAULT_PRESENCE_WINDOW_MINUTES,
    expectedMappingCount,
    lastReplacedAt: raw.last_replaced_at || null,
    lastReplacedBy: raw.last_replaced_by || null,
  };
}

export function validateEscalationRecipientRankingInput(input = {}) {
  const mappings = input.mappings;
  if (!Array.isArray(mappings)) {
    throw AppError.badRequest('mappings must be an array', 'ESCALATION_RANK_MAPPINGS_INVALID');
  }
  if (mappings.length > MAX_RANK_MAPPINGS) {
    throw AppError.badRequest(
      `mappings must contain at most ${MAX_RANK_MAPPINGS} entries`,
      'ESCALATION_RANK_MAPPINGS_TOO_LARGE',
    );
  }
  const presenceWindowMinutes = input.presenceWindowMinutes == null
    ? DEFAULT_PRESENCE_WINDOW_MINUTES
    : Number(input.presenceWindowMinutes);
  if (
    !Number.isInteger(presenceWindowMinutes)
    || presenceWindowMinutes < MIN_PRESENCE_WINDOW_MINUTES
    || presenceWindowMinutes > MAX_PRESENCE_WINDOW_MINUTES
  ) {
    throw AppError.badRequest(
      `presenceWindowMinutes must be an integer from ${MIN_PRESENCE_WINDOW_MINUTES} through ${MAX_PRESENCE_WINDOW_MINUTES}`,
      'ESCALATION_PRESENCE_WINDOW_INVALID',
    );
  }

  const seen = new Set();
  const normalizedMappings = mappings.map((mapping, index) => {
    const sourceKind = String(mapping?.sourceKind ?? '').trim().toLowerCase();
    const sourceValue = displayLabel(mapping?.sourceValue);
    const normalizedSourceValue = normalizeEscalationRankLabel(sourceValue);
    const priorityRank = Number(mapping?.priorityRank);
    if (!SOURCE_KINDS.has(sourceKind)) {
      throw AppError.badRequest(
        `mappings[${index}].sourceKind must be position or designation`,
        'ESCALATION_RANK_SOURCE_KIND_INVALID',
      );
    }
    if (!normalizedSourceValue || sourceValue.length > 100) {
      throw AppError.badRequest(
        `mappings[${index}].sourceValue must contain 1 through 100 characters`,
        'ESCALATION_RANK_SOURCE_VALUE_INVALID',
      );
    }
    if (!Number.isInteger(priorityRank) || priorityRank < 1 || priorityRank > 100) {
      throw AppError.badRequest(
        `mappings[${index}].priorityRank must be an integer from 1 through 100`,
        'ESCALATION_RANK_PRIORITY_INVALID',
      );
    }
    const identity = `${sourceKind}\u0000${normalizedSourceValue}`;
    if (seen.has(identity)) {
      throw AppError.badRequest(
        `mappings contains a duplicate ${sourceKind} label`,
        'ESCALATION_RANK_MAPPING_DUPLICATE',
      );
    }
    seen.add(identity);
    return { sourceKind, sourceValue, normalizedSourceValue, priorityRank };
  });
  return { mappings: normalizedMappings, presenceWindowMinutes };
}

function toResponse(control, rows) {
  return {
    ...control,
    mappings: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      sourceKind: row.source_kind,
      sourceValue: row.source_value,
      priorityRank: Number(row.priority_rank),
    })),
  };
}

async function loadRankingRows(tx, tenantId) {
  return tx.$queryRawUnsafe(
    `SELECT id, source_kind, source_value, priority_rank
       FROM escalation_recipient_rank_mappings
      WHERE tenant_id = $1::uuid
      ORDER BY priority_rank ASC, source_kind ASC, normalized_source_value ASC, id ASC`,
    tenantId,
  );
}

export async function getEscalationRecipientRankings(tenantId) {
  return setTenantTx(tenantId, async (tx) => {
    const tenants = await tx.$queryRawUnsafe(
      `SELECT settings
         FROM tenants
        WHERE id = $1::uuid
        LIMIT 1`,
      tenantId,
    );
    if (!tenants?.[0]) {
      throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
    }
    const rows = await loadRankingRows(tx, tenantId);
    return toResponse(rankingControl(tenants[0].settings), rows);
  }, { readOnly: true });
}

export async function replaceEscalationRecipientRankings({
  tenantId,
  mappings,
  presenceWindowMinutes,
  actorUid,
  actorRole,
  ipAddress,
  userAgent,
}) {
  const validated = validateEscalationRecipientRankingInput({ mappings, presenceWindowMinutes });
  const actor = normalizeActorUid(actorUid);
  const role = String(actorRole ?? '').slice(0, 50) || null;
  const replacedAt = new Date().toISOString();

  return setTenantTx(tenantId, async (tx) => {
    const tenants = await tx.$queryRawUnsafe(
      `SELECT settings
         FROM tenants
        WHERE id = $1::uuid
        FOR UPDATE`,
      tenantId,
    );
    if (!tenants?.[0]) {
      throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
    }
    const beforeRows = await loadRankingRows(tx, tenantId);
    const before = toResponse(rankingControl(tenants[0].settings), beforeRows);

    await tx.$executeRawUnsafe(
      `DELETE FROM escalation_recipient_rank_mappings
        WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    for (const mapping of validated.mappings) {
      await tx.$executeRawUnsafe(
        `INSERT INTO escalation_recipient_rank_mappings
           (tenant_id, source_kind, source_value, normalized_source_value,
            priority_rank, created_by, updated_by, created_at, updated_at)
         VALUES
           ($1::uuid, $2::text, $3::text, $4::text,
            $5::smallint, $6::uuid, $6::uuid, $7::timestamptz, $7::timestamptz)`,
        tenantId,
        mapping.sourceKind,
        mapping.sourceValue,
        mapping.normalizedSourceValue,
        mapping.priorityRank,
        actor,
        replacedAt,
      );
    }

    const control = {
      configured: true,
      revision: before.revision + 1,
      presence_window_minutes: validated.presenceWindowMinutes,
      expected_mapping_count: validated.mappings.length,
      last_replaced_at: replacedAt,
      last_replaced_by: actor,
    };
    const tenantUpdates = await tx.$queryRawUnsafe(
      `UPDATE tenants
          SET settings = jsonb_set(
                COALESCE(settings, '{}'::jsonb),
                '{escalation_recipient_ranking}',
                $2::jsonb,
                TRUE
              ),
              updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING settings`,
      tenantId,
      JSON.stringify(control),
    );
    const afterRows = await loadRankingRows(tx, tenantId);
    const after = toResponse(rankingControl(tenantUpdates[0].settings), afterRows);

    await tx.$executeRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata,
          ip_address, user_agent, actor_uid, created_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text,
          'ESCALATION_RECIPIENT_RANKINGS_REPLACED',
          'tenant', $1::text,
          jsonb_build_object(
            'before', $4::jsonb,
            'after', $5::jsonb,
            'actor', jsonb_build_object('uid', $2::uuid, 'role', $3::text)
          ),
          $6::text, $7::text, $2::uuid, NOW())`,
      tenantId,
      actor,
      role,
      JSON.stringify(before),
      JSON.stringify(after),
      ipAddress == null ? null : String(ipAddress).slice(0, 45),
      userAgent == null ? null : String(userAgent).slice(0, 500),
    );
    return after;
  });
}

export const __testing__ = {
  rankingControl,
  normalizeActorUid,
};

export default {
  getEscalationRecipientRankings,
  replaceEscalationRecipientRankings,
};
