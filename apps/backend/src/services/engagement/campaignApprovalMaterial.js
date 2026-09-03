// Canonical "approval material" for an engagement campaign: the fields a
// reviewer approves, reduced to one stable object and one sha256, so the
// approval can record what it approved and later paths can prove nothing
// changed. Pure: no database, no clock.
//
// Two lists govern the audience part and are pinned by the unit test:
//   RECIPIENT_IDENTITY_FIELDS  — who is contacted, how, when, with what inputs
//   RECIPIENT_DISPATCH_FIELDS  — everything the dispatch path or a consent
//                                re-check writes. These must never enter the
//                                hash, or the system would invalidate its own
//                                approval the moment it sends.
//
// Design note: docs/superpowers/specs/2026-09-03-engagement-campaign-approval-material-binding-design.md
import crypto from 'node:crypto';

export const APPROVAL_MATERIAL_VERSION = 1;

export const RECIPIENT_IDENTITY_FIELDS = Object.freeze([
  'idempotency_key',
  'patient_uid',
  'channel',
  'due_at',
  'required_consent_type',
  'variables'
]);

export const RECIPIENT_DISPATCH_FIELDS = Object.freeze([
  'status',
  'suppression_reason',
  'consent_id',
  'contact_route',
  'outbox_id',
  'delivery_metadata',
  'retry_count',
  'materialized_at',
  'last_consent_checked_at',
  'queued_at',
  'sent_at',
  'failed_at',
  'created_at',
  'updated_at'
]);

/** Recursively sort object keys so JSON.stringify is order-independent. */
export function stableJson(value) {
  if (Array.isArray(value)) return value.map(entry => stableJson(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableJson(value[key])])
  );
}

export function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJson(value)))
    .digest('hex');
}

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function sortedStrings(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(entry => String(entry)))].sort();
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** The part of a recipient row a reviewer approved: identity and message inputs. */
export function recipientIdentity(row) {
  const patientUid = text(row.patient_uid);
  return {
    idempotency_key: text(row.idempotency_key),
    patient_uid: patientUid === null ? null : patientUid.toLowerCase(),
    channel: text(row.channel),
    due_at: isoOrNull(row.due_at),
    required_consent_type: text(row.required_consent_type),
    variables: stableJson(objectOrEmpty(row.variables))
  };
}

/** sha256 over the recipient identities, independent of row order. */
export function hashRecipientRows(rows) {
  const identities = (rows || []).map(recipientIdentity);
  identities.sort((a, b) => {
    const left = a.idempotency_key ?? '';
    const right = b.idempotency_key ?? '';
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return sha256Json(identities);
}

/**
 * Build the canonical material from a campaign context row (the service's
 * loadCampaignContext shape: campaign columns plus the joined template and
 * notification-template columns), the current audience snapshot row (or
 * null) and that snapshot's recipient rows.
 */
export function buildApprovalMaterial({ campaign, snapshot = null, recipients = [] }) {
  const rows = Array.isArray(recipients) ? recipients : [];
  return {
    version: APPROVAL_MATERIAL_VERSION,
    campaign: {
      campaign_type: text(campaign.campaign_type),
      objective: text(campaign.objective),
      audience_kind: text(campaign.audience_kind),
      approval_required_role: text(campaign.approval_required_role),
      channels: sortedStrings(campaign.channels),
      schedule_policy: stableJson(objectOrEmpty(campaign.schedule_policy)),
      rate_policy: stableJson(objectOrEmpty(campaign.rate_policy)),
      scheduled_at: isoOrNull(campaign.scheduled_at)
    },
    template: {
      engagement_template_id: text(campaign.template_id),
      notification_template_id: text(campaign.notification_template_id),
      channel: text(campaign.template_channel),
      allowed_variables: sortedStrings(campaign.allowed_variables),
      phi_classification: text(campaign.phi_classification),
      locale: text(campaign.template_locale),
      title_template: text(campaign.title_template),
      message_template: text(campaign.message_template),
      notification_type: text(campaign.notification_type)
    },
    audience: {
      snapshot_id: snapshot ? text(snapshot.id) : null,
      snapshot_kind: snapshot ? text(snapshot.snapshot_kind) : null,
      cohort_hash: snapshot ? text(snapshot.cohort_hash) : null,
      recipient_count: rows.length,
      recipients_hash: hashRecipientRows(rows)
    }
  };
}

export function hashApprovalMaterial(material) {
  return sha256Json(material);
}

/** `section.field` paths whose values differ between two materials, sorted. */
export function describeMaterialDifference(before, after) {
  const left = objectOrEmpty(before);
  const right = objectOrEmpty(after);
  const paths = [];
  const same = (a, b) =>
    JSON.stringify(stableJson(a) ?? null) === JSON.stringify(stableJson(b) ?? null);
  for (const section of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const a = left[section];
    const b = right[section];
    const bothObjects =
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b);
    if (!bothObjects) {
      if (!same(a, b)) paths.push(section);
      continue;
    }
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!same(a[field], b[field])) paths.push(`${section}.${field}`);
    }
  }
  return paths.sort();
}
