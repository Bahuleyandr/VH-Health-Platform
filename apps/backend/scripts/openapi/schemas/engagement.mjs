// apps/backend/scripts/openapi/schemas/engagement.mjs
// NL9 patient-engagement console — read endpoints.
//
// The engagement router shipped write-only (POST /templates, POST /campaigns
// and five POST campaign actions), so the admin console could not list what it
// created: a campaign was addressable only by an id the caller already held.
// These three GETs close that hole; they are documented here because
// `.spectral-baseline.txt` only ever shrinks, so a new operation must arrive
// with a description rather than a new baselined warning.
//
// These descriptions used to call the approve step a "second approver" control.
// It is not one. `approveCampaign`
// (services/engagement/engagementCampaignService.js) gates on the caller's ROLE
// and nothing else — it never compares the approver against `submitted_by` or
// `created_by`, so a caller holding an approving role may approve a campaign
// they submitted themselves. A real requester/approver separation would be a
// new control, not a documentation fix; it is parked in docs/ROADMAP.md.

export const operations = {
  'GET /api/v1/engagement/campaigns': {
    description:
      'Tenant-scoped campaign list for the engagement console. Filters: `status` (draft, dry_run, pending_approval, scheduled, running, paused, completed, archived, cancelled) and `campaign_type`; an unrecognised value is rejected with ENGAGEMENT_BAD_LIST_FILTER rather than silently returning an empty page. Paginated via `page`/`limit` (default 20, max 100) and sortable on created_at, updated_at, scheduled_at or status. Payload is `{ campaigns, pagination }`. Without it a campaign is addressable only by an id the caller already holds, so a console session cannot find one created elsewhere — `status=pending_approval` is the filter that lists the campaigns waiting on the role-gated approve action.',
  },
  'GET /api/v1/engagement/campaigns/{campaignId}': {
    description:
      'Single tenant-scoped engagement campaign, so a campaign can be opened by id from a queue or a link rather than only from the session that created it. 404 ENGAGEMENT_CAMPAIGN_NOT_FOUND when the id does not exist inside the caller\'s tenant.',
  },
  'GET /api/v1/engagement/templates': {
    description:
      'Tenant-scoped engagement template list. Retired templates are hidden unless `include_retired=true`, matching the `WHERE retired_at IS NULL` partial indexes on the table. Filters: `template_kind`, `channel`. Paginated via `page`/`limit` (default 20, max 100). Payload is `{ templates, pagination }`.',
  },
};

export default { operations };
