// apps/backend/src/routes/engagement/engagementListQueries.js
//
// Read-side queries for the NL9 patient-engagement console.
//
// WHY THIS FILE EXISTS
// The engagement router shipped with a write-only verb list — GET/PUT
// /settings, POST /templates, POST /campaigns and five POST campaign actions —
// and no way to read a campaign or a template back. The admin console used to
// document the hole in its own on-screen copy — "The engagement API exposes no
// listing endpoints — templates and campaigns created or transitioned in this
// session appear below" — and worked around it with a session-local workspace.
// (That sentence is gone from
// apps/admin/src/app/(with-auth)/dashboard/engagement/page.tsx now that these
// GETs exist; it is quoted here only as the record of the gap.) A campaign was
// addressable only by an id the caller already held: a campaign parked in
// `pending_approval` was invisible to every console session except the tab that
// submitted it, so nobody else could open it to approve it.
//
// APPROVAL BOUNDARY
// `approveCampaign` checks the caller's governed approval role, requires an
// authenticated identity and approval reason, and rejects an approver whose uid
// matches the campaign's immutable `submitted_by`. These GETs make the pending
// campaign discoverable to that distinct reviewer; they do not themselves
// authorize or perform a transition.
//
// WHY IT LIVES HERE RATHER THAN IN THE SERVICE
// services/engagement/engagementCampaignService.js owns the campaign state
// machine (create -> dry-run -> materialize -> submit -> approve -> queue-due).
// Every method there writes. These are pure reads, and keeping them in a
// separate module is a structural guarantee that the approval/queue path gains
// no new statement, no new throw and no new failure mode from this change.
//
// TENANT SCOPING
// Same contract as the service: setTenant() so RLS is active, plus an explicit
// `tenant_id = $1::uuid` predicate — the house pattern wherever scoping has to
// be provable rather than merely configured (apps/backend/CLAUDE.md, PR #684).

import { setTenant } from '../../lib/prisma.js';
import { CAMPAIGN_TYPES, ENGAGEMENT_CHANNELS } from '../../services/engagement/engagementCampaignService.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

/**
 * Mirrors `engagement_campaigns_status_check`
 * (src/migrations/436_engagement_campaigns_audiences.sql). Kept local because
 * the service does not export it; a value outside this list is rejected as a
 * bad filter rather than silently returning an empty page.
 */
export const CAMPAIGN_STATUSES = Object.freeze([
  'draft',
  'dry_run',
  'pending_approval',
  'scheduled',
  'running',
  'paused',
  'completed',
  'archived',
  'cancelled',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CAMPAIGN_SORT_FIELDS = Object.freeze(['created_at', 'updated_at', 'scheduled_at', 'status']);
const TEMPLATE_SORT_FIELDS = Object.freeze(['created_at', 'updated_at', 'template_kind']);

/**
 * Same normalisation the service applies to its own returns, so a row read
 * back through GET is byte-identical in shape to the row POST handed out:
 * BIGSERIAL ids arrive as BigInt (unserialisable by JSON.stringify) and
 * TIMESTAMPTZ columns arrive as Date.
 */
function jsonReady(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => jsonReady(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonReady(entry)]));
  }
  return value;
}

function requireTenantId(tenantId) {
  const value = String(tenantId || '').trim();
  if (!UUID_RE.test(value)) {
    throw AppError.badRequest('Tenant context is required', 'ENGAGEMENT_TENANT_REQUIRED');
  }
  return value;
}

function optionalEnumFilter(raw, allowed, field) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return null;
  if (!allowed.includes(value)) {
    throw AppError.badRequest(
      `${field} must be one of: ${allowed.join(', ')}`,
      'ENGAGEMENT_BAD_LIST_FILTER',
    );
  }
  return value;
}

function truthy(raw) {
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/** BIGSERIAL primary key arriving as a path/query string. */
export function campaignIdOrThrow(raw) {
  const value = String(raw ?? '').trim();
  if (!/^[1-9][0-9]{0,17}$/.test(value)) {
    throw AppError.badRequest('campaignId must be a positive integer', 'ENGAGEMENT_BAD_CAMPAIGN_ID');
  }
  return value;
}

const CAMPAIGN_COLUMNS = `
  id, tenant_id, campaign_type, objective, status, template_id, channels,
  schedule_policy, rate_policy, audience_kind, approval_required_role,
  created_by, submitted_by, submitted_at, approved_by, approved_at,
  scheduled_at, started_at, completed_at, cancelled_at,
  frozen_audience_hash, current_audience_snapshot_id, created_at, updated_at
`;

const TEMPLATE_COLUMNS = `
  id, tenant_id, notification_template_id, template_kind, channel,
  variables_schema, allowed_variables, phi_classification, locale,
  approved_by, approved_at, retired_at, created_by, created_at, updated_at
`;

/**
 * Tenant-scoped campaign list.
 *
 * @param {string} tenantId
 * @param {object} query Express `req.query`
 * @returns {Promise<{campaigns: object[], pagination: object}>}
 */
export async function listEngagementCampaigns(tenantId, query = {}) {
  const tid = requireTenantId(tenantId);
  const { page, limit, offset, sortBy, sortOrder } = parseListQuery(query, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at',
    allowedSortFields: CAMPAIGN_SORT_FIELDS,
  });

  const status = optionalEnumFilter(query.status, CAMPAIGN_STATUSES, 'status');
  const campaignType = optionalEnumFilter(
    query.campaign_type ?? query.campaignType,
    CAMPAIGN_TYPES,
    'campaign_type',
  );

  // `sortBy`/`sortOrder` are safe to interpolate: parseListQuery replaces
  // anything outside CAMPAIGN_SORT_FIELDS with the default, and
  // normalizeSortOrder collapses to the literal 'ASC' or 'DESC'.
  const filters = [];
  const params = [tid];
  if (status) {
    params.push(status);
    filters.push(`AND status = $${params.length}`);
  }
  if (campaignType) {
    params.push(campaignType);
    filters.push(`AND campaign_type = $${params.length}`);
  }
  const where = `WHERE tenant_id = $1::uuid ${filters.join(' ')}`;

  return setTenant(tid, async (tx) => {
    const countRows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total FROM engagement_campaigns ${where}`,
      ...params,
    );
    const total = countRows[0]?.total || 0;

    const rows = await tx.$queryRawUnsafe(
      `SELECT ${CAMPAIGN_COLUMNS}
         FROM engagement_campaigns
        ${where}
        ORDER BY ${sortBy} ${sortOrder} NULLS LAST, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      limit,
      offset,
    );

    return {
      campaigns: rows.map((row) => jsonReady(row)),
      pagination: buildPagination(total, page, limit),
    };
  }, { readOnly: true });
}

/**
 * Single tenant-scoped campaign, so a campaign can be opened by id from a link
 * or a queue rather than only from the tab that created it.
 *
 * @param {string} tenantId
 * @param {string|number} campaignId
 * @returns {Promise<object>}
 */
export async function getEngagementCampaign(tenantId, campaignId) {
  const tid = requireTenantId(tenantId);
  const cid = campaignIdOrThrow(campaignId);

  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT ${CAMPAIGN_COLUMNS}
       FROM engagement_campaigns
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1`,
    tid,
    cid,
  ), { readOnly: true });

  if (!rows.length) {
    throw AppError.notFound('Engagement campaign not found', 'ENGAGEMENT_CAMPAIGN_NOT_FOUND');
  }
  return jsonReady(rows[0]);
}

/**
 * Tenant-scoped template list. Retired templates are hidden unless
 * `?include_retired=true`, matching the partial indexes migration 435 builds
 * (`WHERE retired_at IS NULL`).
 *
 * @param {string} tenantId
 * @param {object} query Express `req.query`
 * @returns {Promise<{templates: object[], pagination: object}>}
 */
export async function listEngagementTemplates(tenantId, query = {}) {
  const tid = requireTenantId(tenantId);
  const { page, limit, offset, sortBy, sortOrder } = parseListQuery(query, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at',
    allowedSortFields: TEMPLATE_SORT_FIELDS,
  });

  const templateKind = optionalEnumFilter(
    query.template_kind ?? query.templateKind,
    CAMPAIGN_TYPES,
    'template_kind',
  );
  const channel = optionalEnumFilter(query.channel, ENGAGEMENT_CHANNELS, 'channel');
  const includeRetired = truthy(query.include_retired ?? query.includeRetired);

  const filters = [];
  const params = [tid];
  if (!includeRetired) filters.push('AND retired_at IS NULL');
  if (templateKind) {
    params.push(templateKind);
    filters.push(`AND template_kind = $${params.length}`);
  }
  if (channel) {
    params.push(channel);
    filters.push(`AND channel = $${params.length}`);
  }
  const where = `WHERE tenant_id = $1::uuid ${filters.join(' ')}`;

  return setTenant(tid, async (tx) => {
    const countRows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total FROM engagement_templates ${where}`,
      ...params,
    );
    const total = countRows[0]?.total || 0;

    const rows = await tx.$queryRawUnsafe(
      `SELECT ${TEMPLATE_COLUMNS}
         FROM engagement_templates
        ${where}
        ORDER BY ${sortBy} ${sortOrder} NULLS LAST, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      limit,
      offset,
    );

    return {
      templates: rows.map((row) => jsonReady(row)),
      pagination: buildPagination(total, page, limit),
    };
  }, { readOnly: true });
}

export default {
  CAMPAIGN_STATUSES,
  campaignIdOrThrow,
  getEngagementCampaign,
  listEngagementCampaigns,
  listEngagementTemplates,
};
