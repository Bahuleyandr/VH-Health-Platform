# Engagement Campaign Approval Material Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an engagement campaign's approval record what was approved, and refuse to materialize or dispatch anything that no longer matches it.

**Architecture:** A pure module builds a canonical "approval material" object (campaign fields, template content, audience recipient identity) and hashes it. Migration 763 adds three columns to `engagement_campaigns`. The service writes the material at submit, stamps the approved hash at approve after re-verifying, refuses post-approval re-materialization, and at queue time re-verifies inside one tenant transaction before selecting due recipients filtered by the approved snapshot; any mismatch resets the campaign to draft with an audit row before the 409 is raised.

**Tech Stack:** Node 26.5.0 ESM, Jest 30 via `npm test` (`--experimental-vm-modules`), PostgreSQL 17 (scratch DB `vh_dq16` on `127.0.0.1:55432`, a copy of `vh_pr970` at migration 762), Prisma schema kept in sync by `scripts/check-schema-drift.mjs`. Spec: `docs/superpowers/specs/2026-09-03-engagement-campaign-approval-material-binding-design.md`.

All commands run from `C:\Users\subas\AppData\Local\Temp\claude\D--Dev\2f11079d-26a5-4494-b8f9-583c88a21415\scratchpad\wt\o22\apps\backend` with `D:\Dev\Tools\node-26.5.0` first on `PATH`. Deep tests need `DATABASE_URL=<base>/vh_dq16` where `<base>` is the cluster URL in `scratchpad/o16/db-base.txt`.

---

## File structure

- Create `apps/backend/src/services/engagement/campaignApprovalMaterial.js` — canonical material, hashing, recipient identity, difference description. No I/O.
- Create `apps/backend/src/tests/unit/campaignApprovalMaterial.test.js` — included/excluded field tables, order independence, source contract that every column the dispatch path writes is excluded.
- Create `apps/backend/src/migrations/763_engagement_campaign_approval_material.sql`.
- Modify `apps/backend/prisma/schema.prisma` (model `engagement_campaigns`), `apps/backend/src/routes/engagement/engagementListQueries.js` (`CAMPAIGN_COLUMNS`).
- Modify `apps/backend/src/services/engagement/engagementCampaignService.js`: imports, `stableJson` removal, `writeCampaignTransitionAudit` details, `loadCampaignContext` SELECT, new `loadApprovalMaterial` and `resetCampaignToDraft`, `materializeCampaignRecipients`, `applyCampaignTransition` replacing `updateCampaignStatus`, `submitCampaignForApproval`, `approveCampaign`, `queueDueCampaignRecipients`.
- Modify `apps/backend/src/tests/engagement-campaigns.deep.test.js`: assertions on the happy path plus four new tests.

---

### Task 1: Failing unit test for the material module

**Files:**
- Test: `apps/backend/src/tests/unit/campaignApprovalMaterial.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RECIPIENT_DISPATCH_FIELDS,
  RECIPIENT_IDENTITY_FIELDS,
  buildApprovalMaterial,
  describeMaterialDifference,
  hashApprovalMaterial,
  hashRecipientRows,
  recipientIdentity
} from '../../services/engagement/campaignApprovalMaterial.js';

// The approval material is what a reviewer approves. Every field a reviewer
// reads must move the hash; nothing the dispatch path writes may move it,
// or the system would invalidate its own approval the moment it sends.

const campaign = {
  id: 42,
  status: 'pending_approval',
  campaign_type: 'appointment_recall',
  objective: 'Recall patients with an upcoming follow-up',
  audience_kind: 'cohort',
  approval_required_role: 'care_team',
  channels: ['sms', 'push'],
  schedule_policy: { window: 'morning', days: ['mon', 'wed'] },
  rate_policy: { per_patient_cooldown_hours: 0 },
  scheduled_at: '2026-09-04T09:00:00.000Z',
  template_id: 7,
  notification_template_id: 3,
  template_channel: 'sms',
  allowed_variables: ['first_name', 'appointment_window'],
  phi_classification: 'minimal',
  template_locale: 'en-IN',
  title_template: 'Visit reminder',
  message_template: 'Hi {{first_name}}, your visit is {{appointment_window}}.',
  notification_type: 'engagement_campaign',
  submitted_by: '00000000-0000-4000-8000-00000000e9aa',
  submitted_at: '2026-09-03T10:00:00.000Z',
  approved_by: null,
  approved_at: null,
  updated_at: '2026-09-03T10:00:00.000Z'
};
const snapshot = { id: 9, snapshot_kind: 'materialized', cohort_hash: 'abc123', materialized_count: 2 };
const recipients = [
  {
    idempotency_key: '42:00000000-0000-4000-8000-00000000e912:sms',
    patient_uid: '00000000-0000-4000-8000-00000000E912',
    channel: 'sms',
    due_at: new Date('2026-09-04T09:00:00.000Z'),
    required_consent_type: 'care_reminder_whatsapp',
    variables: { appointment_window: 'tomorrow', first_name: 'Asha' },
    status: 'eligible',
    suppression_reason: null,
    consent_id: 5,
    contact_route: '+919000009912',
    outbox_id: null,
    delivery_metadata: {},
    retry_count: 0,
    queued_at: null,
    sent_at: null
  },
  {
    idempotency_key: '42:00000000-0000-4000-8000-00000000e911:sms',
    patient_uid: '00000000-0000-4000-8000-00000000e911',
    channel: 'sms',
    due_at: '2026-09-04T09:00:00.000Z',
    required_consent_type: 'care_reminder_whatsapp',
    variables: { first_name: 'Ravi', appointment_window: 'tomorrow' },
    status: 'suppressed',
    suppression_reason: 'missing_consent',
    consent_id: null,
    contact_route: null,
    outbox_id: null,
    delivery_metadata: {},
    retry_count: 0,
    queued_at: null,
    sent_at: null
  }
];

const clone = value => JSON.parse(JSON.stringify(value));
const baseHash = () => hashApprovalMaterial(buildApprovalMaterial({ campaign, snapshot, recipients }));
const hashWith = ({ campaign: c = campaign, snapshot: s = snapshot, recipients: r = recipients } = {}) =>
  hashApprovalMaterial(buildApprovalMaterial({ campaign: c, snapshot: s, recipients: r }));

describe('buildApprovalMaterial', () => {
  it('builds the canonical shape a reviewer approves', () => {
    const material = buildApprovalMaterial({ campaign, snapshot, recipients });
    expect(material.version).toBe(1);
    expect(material.campaign).toEqual({
      campaign_type: 'appointment_recall',
      objective: 'Recall patients with an upcoming follow-up',
      audience_kind: 'cohort',
      approval_required_role: 'care_team',
      channels: ['push', 'sms'],
      schedule_policy: { days: ['mon', 'wed'], window: 'morning' },
      rate_policy: { per_patient_cooldown_hours: 0 },
      scheduled_at: '2026-09-04T09:00:00.000Z'
    });
    expect(material.template).toEqual({
      engagement_template_id: '7',
      notification_template_id: '3',
      channel: 'sms',
      allowed_variables: ['appointment_window', 'first_name'],
      phi_classification: 'minimal',
      locale: 'en-IN',
      title_template: 'Visit reminder',
      message_template: 'Hi {{first_name}}, your visit is {{appointment_window}}.',
      notification_type: 'engagement_campaign'
    });
    expect(material.audience).toEqual({
      snapshot_id: '9',
      snapshot_kind: 'materialized',
      cohort_hash: 'abc123',
      recipient_count: 2,
      recipients_hash: hashRecipientRows(recipients)
    });
    expect(baseHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('describes an unmaterialized audience honestly', () => {
    const material = buildApprovalMaterial({ campaign, snapshot: null, recipients: [] });
    expect(material.audience).toEqual({
      snapshot_id: null,
      snapshot_kind: null,
      cohort_hash: null,
      recipient_count: 0,
      recipients_hash: hashRecipientRows([])
    });
  });
});

describe('hash stability', () => {
  it('does not depend on object key order or recipient order', () => {
    const shuffledCampaign = Object.fromEntries(Object.entries(campaign).reverse());
    shuffledCampaign.schedule_policy = { days: ['mon', 'wed'], window: 'morning' };
    const reversedRecipients = [...recipients].reverse().map(row => Object.fromEntries(Object.entries(row).reverse()));
    expect(hashWith({ campaign: shuffledCampaign, recipients: reversedRecipients })).toBe(baseHash());
  });

  it('normalises patient uid case and Date/string due_at to one identity', () => {
    const a = recipientIdentity(recipients[0]);
    const b = recipientIdentity({ ...recipients[0], patient_uid: recipients[0].patient_uid.toLowerCase(), due_at: '2026-09-04T09:00:00.000Z' });
    expect(a).toEqual(b);
    expect(a.due_at).toBe('2026-09-04T09:00:00.000Z');
    expect(a.patient_uid).toBe('00000000-0000-4000-8000-00000000e912');
  });
});

describe('every field a reviewer approves moves the hash', () => {
  it.each([
    ['campaign.objective', c => { c.objective = 'Different purpose'; }],
    ['campaign.campaign_type', c => { c.campaign_type = 'no_show_recall'; }],
    ['campaign.audience_kind', c => { c.audience_kind = 'broad'; }],
    ['campaign.approval_required_role', c => { c.approval_required_role = 'admin_quality'; }],
    ['campaign.channels', c => { c.channels = ['sms', 'push', 'email']; }],
    ['campaign.schedule_policy', c => { c.schedule_policy = { window: 'evening' }; }],
    ['campaign.rate_policy', c => { c.rate_policy = { per_patient_cooldown_hours: 48 }; }],
    ['campaign.scheduled_at', c => { c.scheduled_at = '2026-09-05T09:00:00.000Z'; }],
    ['template.engagement_template_id', c => { c.template_id = 8; }],
    ['template.notification_template_id', c => { c.notification_template_id = 4; }],
    ['template.channel', c => { c.template_channel = 'whatsapp'; }],
    ['template.allowed_variables', c => { c.allowed_variables = ['first_name']; }],
    ['template.phi_classification', c => { c.phi_classification = 'operational'; }],
    ['template.locale', c => { c.template_locale = 'ta-IN'; }],
    ['template.title_template', c => { c.title_template = 'Reminder'; }],
    ['template.message_template', c => { c.message_template = 'Hello {{first_name}}'; }],
    ['template.notification_type', c => { c.notification_type = 'general'; }]
  ])('%s', (_label, mutate) => {
    const mutated = clone(campaign);
    mutate(mutated);
    expect(hashWith({ campaign: mutated })).not.toBe(baseHash());
  });

  it.each([
    ['audience.snapshot_id', s => { s.id = 10; }],
    ['audience.snapshot_kind', s => { s.snapshot_kind = 'dry_run'; }],
    ['audience.cohort_hash', s => { s.cohort_hash = 'def456'; }]
  ])('%s', (_label, mutate) => {
    const mutated = clone(snapshot);
    mutate(mutated);
    expect(hashWith({ snapshot: mutated })).not.toBe(baseHash());
  });

  it.each([
    ['a recipient added', r => { r.push({ ...clone(r[0]), idempotency_key: '42:p3:sms', patient_uid: 'p3' }); }],
    ['a recipient removed', r => { r.pop(); }],
    ['recipient.patient_uid', r => { r[0].patient_uid = '00000000-0000-4000-8000-00000000e999'; }],
    ['recipient.channel', r => { r[0].channel = 'whatsapp'; }],
    ['recipient.due_at', r => { r[0].due_at = '2026-09-06T09:00:00.000Z'; }],
    ['recipient.required_consent_type', r => { r[0].required_consent_type = 'care_reminder_sms'; }],
    ['recipient.variables', r => { r[0].variables = { first_name: 'Someone else', appointment_window: 'tomorrow' }; }],
    ['recipient.idempotency_key', r => { r[0].idempotency_key = '42:other:sms'; }]
  ])('%s', (_label, mutate) => {
    const mutated = clone(recipients);
    mutate(mutated);
    expect(hashWith({ recipients: mutated })).not.toBe(baseHash());
  });
});

describe('nothing the dispatch path writes moves the hash', () => {
  it.each([
    ['recipient.status', r => { r[0].status = 'queued'; r[1].status = 'failed'; }],
    ['recipient.suppression_reason', r => { r[0].suppression_reason = 'quiet_hours'; }],
    ['recipient.consent_id', r => { r[0].consent_id = 99; }],
    ['recipient.contact_route', r => { r[0].contact_route = '+910000000000'; }],
    ['recipient.outbox_id', r => { r[0].outbox_id = 1234; }],
    ['recipient.delivery_metadata', r => { r[0].delivery_metadata = { outbox_type: 'engagement_campaign' }; }],
    ['recipient.retry_count', r => { r[0].retry_count = 3; }],
    ['recipient timestamps', r => { r[0].queued_at = '2026-09-04T09:01:00.000Z'; r[0].sent_at = '2026-09-04T09:02:00.000Z'; r[0].last_consent_checked_at = '2026-09-04T09:00:30.000Z'; }]
  ])('%s', (_label, mutate) => {
    const mutated = clone(recipients);
    mutate(mutated);
    expect(hashWith({ recipients: mutated })).toBe(baseHash());
  });

  it.each([
    ['campaign.status', c => { c.status = 'running'; }],
    ['campaign actors and timestamps', c => { c.approved_by = 'x'; c.approved_at = 'y'; c.updated_at = 'z'; c.submitted_by = null; }],
    ['campaign.current_audience_snapshot_id', c => { c.current_audience_snapshot_id = 77; }]
  ])('%s', (_label, mutate) => {
    const mutated = clone(campaign);
    mutate(mutated);
    expect(hashWith({ campaign: mutated })).toBe(baseHash());
  });

  it('ignores snapshot counts, which dispatch verdicts change', () => {
    expect(hashWith({ snapshot: { ...snapshot, materialized_count: 99, eligible_count: 1 } })).toBe(baseHash());
  });

  it('keeps the identity and dispatch field lists disjoint and covers every column the queue path writes', () => {
    expect(RECIPIENT_IDENTITY_FIELDS.filter(field => RECIPIENT_DISPATCH_FIELDS.includes(field))).toEqual([]);
    const source = readFileSync(
      fileURLToPath(new URL('../../services/engagement/engagementCampaignService.js', import.meta.url)),
      'utf8'
    );
    const updates = [...source.matchAll(/UPDATE engagement_campaign_recipients\s+SET([\s\S]*?)\n\s*WHERE/g)];
    expect(updates.length).toBeGreaterThanOrEqual(3);
    const written = new Set();
    for (const [, block] of updates) {
      for (const match of block.matchAll(/^\s*([a-z_]+)\s*=/gm)) written.add(match[1]);
    }
    expect([...written].sort()).not.toEqual([]);
    for (const column of written) {
      expect(RECIPIENT_IDENTITY_FIELDS).not.toContain(column);
      expect(RECIPIENT_DISPATCH_FIELDS).toContain(column);
    }
  });
});

describe('describeMaterialDifference', () => {
  it('names the sections and fields that differ', () => {
    const before = buildApprovalMaterial({ campaign, snapshot, recipients });
    const edited = clone(campaign);
    edited.schedule_policy = { window: 'evening' };
    edited.title_template = 'Changed';
    const after = buildApprovalMaterial({ campaign: edited, snapshot, recipients: recipients.slice(0, 1) });
    expect(describeMaterialDifference(before, after)).toEqual([
      'audience.recipient_count',
      'audience.recipients_hash',
      'campaign.schedule_policy',
      'template.title_template'
    ]);
    expect(describeMaterialDifference(before, before)).toEqual([]);
    expect(describeMaterialDifference(null, after)).toContain('campaign.campaign_type');
  });
});
```

- [ ] **Step 2: Run it to verify it fails for the right reason**

Run: `npm test -- --runTestsByPath src/tests/unit/campaignApprovalMaterial.test.js 2>&1 | grep -E "Cannot find module|^(PASS|FAIL)|Tests:"`
Expected: `FAIL` with `Cannot find module '../../services/engagement/campaignApprovalMaterial.js'`.

---

### Task 2: The module

**Files:**
- Create: `apps/backend/src/services/engagement/campaignApprovalMaterial.js`

- [ ] **Step 1: Write the module**

```js
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
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex');
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
 * Build the canonical material from a campaign context row (the seeder's
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
  const same = (a, b) => JSON.stringify(stableJson(a) ?? null) === JSON.stringify(stableJson(b) ?? null);
  for (const section of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const a = left[section];
    const b = right[section];
    const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
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
```

- [ ] **Step 2: Run the unit test**

Run: `npm test -- --runTestsByPath src/tests/unit/campaignApprovalMaterial.test.js 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕"`
Expected: `PASS`, all tests passed. Note: the source-contract test reads the live service file; on main the recipient UPDATE blocks write `status`, `suppression_reason`, `last_consent_checked_at`, `updated_at`, `outbox_id`, `consent_id`, `queued_at`, `delivery_metadata`, `failed_at`, all of which are in the dispatch list.

- [ ] **Step 3: Format, lint, commit**

```bash
node node_modules/prettier/bin/prettier.cjs --write src/services/engagement/campaignApprovalMaterial.js src/tests/unit/campaignApprovalMaterial.test.js
node node_modules/eslint/bin/eslint.js --max-warnings=0 src/services/engagement/campaignApprovalMaterial.js src/tests/unit/campaignApprovalMaterial.test.js
git add src/services/engagement/campaignApprovalMaterial.js src/tests/unit/campaignApprovalMaterial.test.js
git commit -m "feat(engagement): canonical approval material for campaigns

Pure module that reduces a campaign, its template content and its
audience (recipient identity and message inputs) to one stable object
and sha256. The recipient hash excludes every column the dispatch path
writes so an approval cannot be invalidated by its own sends; the unit
test pins the included and excluded field tables and the source contract
that the queue path only writes excluded columns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Migration 763, Prisma model, list columns

**Files:**
- Create: `apps/backend/src/migrations/763_engagement_campaign_approval_material.sql`
- Modify: `apps/backend/prisma/schema.prisma` (model `engagement_campaigns`), `apps/backend/src/routes/engagement/engagementListQueries.js` (`CAMPAIGN_COLUMNS`)

- [ ] **Step 1: Write the migration**

```sql
-- 763_engagement_campaign_approval_material.sql
--
-- Bind an engagement campaign's approval to the material approved.
-- approveCampaign recorded who approved and when, nothing about what; the
-- audience hash was written but never compared, materialize was allowed after
-- approval, and the due-recipient query ignored the approved snapshot
-- (audit row OPEN-16). The service now writes the canonical approval material
-- and its hash at submit, stamps the approved hash at approve after
-- re-verifying, and re-verifies at materialize and queue time.
--
-- Forward-only. Existing rows are not rewritten: the CHECK is NOT VALID, and a
-- campaign approved before this migration carries no approved hash, so the
-- queue path returns it to draft for re-approval instead of dispatching.
-- frozen_audience_hash is kept and now holds the recipients hash of the
-- approved audience, written at submit.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE engagement_campaigns
  ADD COLUMN approval_material JSONB,
  ADD COLUMN approval_material_hash VARCHAR(64),
  ADD COLUMN approved_material_hash VARCHAR(64);

ALTER TABLE engagement_campaigns
  ADD CONSTRAINT engagement_campaigns_approved_material_check
  CHECK (status NOT IN ('scheduled', 'running') OR approved_material_hash IS NOT NULL)
  NOT VALID;

COMMIT;
```

- [ ] **Step 2: Add the columns to the Prisma model**

In `prisma/schema.prisma`, model `engagement_campaigns`, after the `updated_at` line and before the blank line preceding `@@index`:

```prisma
  approval_material            Json?
  approval_material_hash       String?   @db.VarChar(64)
  approved_material_hash       String?   @db.VarChar(64)
```

- [ ] **Step 3: Add the columns to the list query**

In `engagementListQueries.js`, `CAMPAIGN_COLUMNS` becomes:

```js
const CAMPAIGN_COLUMNS = `
  id, tenant_id, campaign_type, objective, status, template_id, channels,
  schedule_policy, rate_policy, audience_kind, approval_required_role,
  created_by, submitted_by, submitted_at, approved_by, approved_at,
  scheduled_at, started_at, completed_at, cancelled_at,
  frozen_audience_hash, current_audience_snapshot_id,
  approval_material, approval_material_hash, approved_material_hash,
  created_at, updated_at
`;
```

- [ ] **Step 4: Apply to the scratch DB and run the drift and contract checks**

```bash
DATABASE_URL=<base>/vh_dq16 node scripts/ci-setup-db.mjs --skip-seeds   # applies 763 only (tracker-driven)
DATABASE_URL=<base>/vh_dq16 node scripts/check-schema-drift.mjs         # expected: schemas match, exit 0
DATABASE_URL=<base>/vh_dq16 npm run db:contracts                          # expected: 0 failures
node ../../scripts/ci/check-migration-immutability.mjs                    # expected: pass (new file only)
node ../../scripts/ci/check-migration-session-guc.mjs                     # expected: pass
```

- [ ] **Step 5: Commit**

```bash
git add src/migrations/763_engagement_campaign_approval_material.sql prisma/schema.prisma src/routes/engagement/engagementListQueries.js
git commit -m "feat(engagement): store approval material and hashes on campaigns (migration 763)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Service wiring

**Files:**
- Modify: `apps/backend/src/services/engagement/engagementCampaignService.js`

- [ ] **Step 1: Import the module; drop the local `stableJson`**

Add after the existing imports:
```js
import {
  buildApprovalMaterial,
  describeMaterialDifference,
  hashApprovalMaterial,
  stableJson
} from './campaignApprovalMaterial.js';
```
Delete the local `function stableJson(value) { ... }` (lines ~181-189). `hashCohortSource` keeps working through the import.

- [ ] **Step 2: Let the transition audit carry details**

```js
async function writeCampaignTransitionAudit(
  tx,
  { tenantId, actorUid, actorRole, campaignId, previousStatus, nextStatus, reason, details = null },
) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, $2, 'ENGAGEMENT_CAMPAIGN_STATUS_CHANGED', 'engagement_campaign',
             $3, $4::jsonb, NOW())`,
    uuidOrNull(actorUid),
    actorRole || null,
    String(campaignId),
    JSON.stringify({
      tenant_id: tenantId,
      previous_status: previousStatus,
      next_status: nextStatus,
      reason: reason || null,
      ...(details || {}),
    }),
  );
}
```

- [ ] **Step 3: Extend `loadCampaignContext`'s SELECT**

Replace the two template-column lines with:
```sql
            c.frozen_audience_hash, c.current_audience_snapshot_id,
            c.approval_material, c.approval_material_hash, c.approved_material_hash,
            et.channel AS template_channel, et.allowed_variables,
            et.phi_classification, et.approved_at AS template_approved_at,
            et.locale AS template_locale, et.notification_template_id,
            nt.title_template, nt.message_template, nt.type AS notification_type
```

- [ ] **Step 4: Add the two helpers after `loadCampaignContext`**

```js
async function loadApprovalMaterial(tx, tenantId, campaign) {
  const snapshotId = campaign.current_audience_snapshot_id;
  let snapshot = null;
  let recipients = [];
  if (snapshotId) {
    const snapshotRows = await tx.$queryRawUnsafe(
      `SELECT id, snapshot_kind, cohort_hash
         FROM engagement_audience_snapshots
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        LIMIT 1`,
      tenantId,
      snapshotId,
    );
    snapshot = snapshotRows[0] ? jsonReady(snapshotRows[0]) : null;
    const recipientRows = await tx.$queryRawUnsafe(
      `SELECT idempotency_key, patient_uid, channel, due_at, required_consent_type, variables
         FROM engagement_campaign_recipients
        WHERE tenant_id = $1::uuid
          AND campaign_id = $2::bigint
          AND audience_snapshot_id = $3::bigint
        ORDER BY idempotency_key ASC`,
      tenantId,
      campaign.id,
      snapshotId,
    );
    recipients = recipientRows.map((row) => jsonReady(row));
  }
  const material = buildApprovalMaterial({ campaign, snapshot, recipients });
  return { material, hash: hashApprovalMaterial(material), snapshot, recipients };
}

// The approval no longer describes the campaign. Clear it, return the
// campaign to draft and record why; callers commit this before raising.
async function resetCampaignToDraft(tx, { tenantId, campaign, actorUid, actorRole, reason, details }) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE engagement_campaigns
        SET status = 'draft',
            submitted_by = NULL,
            submitted_at = NULL,
            approved_by = NULL,
            approved_at = NULL,
            approval_material = NULL,
            approval_material_hash = NULL,
            approved_material_hash = NULL,
            frozen_audience_hash = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $3::varchar
      RETURNING id`,
    tenantId,
    campaign.id,
    campaign.status,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Campaign status changed before the transition completed',
      'ENGAGEMENT_CAMPAIGN_TRANSITION_CONFLICT',
    );
  }
  await writeCampaignTransitionAudit(tx, {
    tenantId,
    actorUid,
    actorRole,
    campaignId: campaign.id,
    previousStatus: campaign.status,
    nextStatus: 'draft',
    reason,
    details,
  });
}

function materialMismatchDetails(campaign, live) {
  return {
    expected_material_hash: campaign.approved_material_hash || campaign.approval_material_hash || null,
    live_material_hash: live.hash,
    changed_sections: describeMaterialDifference(campaign.approval_material, live.material),
  };
}
```

- [ ] **Step 5: Gate `materializeCampaignRecipients`**

Replace the status check and the final UPDATE:

```js
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (['scheduled', 'running'].includes(campaign.status)) {
      throw AppError.conflict(
        'Approved campaigns cannot re-materialize their audience; the approval binds the audience that was approved',
        'ENGAGEMENT_APPROVAL_LOCKED',
      );
    }
    if (!['dry_run', 'pending_approval'].includes(campaign.status)) {
      throw AppError.badRequest('Campaign must be dry-run before recipient materialization', 'ENGAGEMENT_BAD_MATERIALIZE_STATE');
    }
```
and at the end, in place of the UPDATE that set `frozen_audience_hash`:
```js
    if (campaign.status === 'pending_approval') {
      // The submitted audience no longer exists: withdraw the submission.
      await tx.$executeRawUnsafe(
        `UPDATE engagement_campaigns
            SET status = 'dry_run',
                submitted_by = NULL,
                submitted_at = NULL,
                approval_material = NULL,
                approval_material_hash = NULL,
                frozen_audience_hash = NULL,
                current_audience_snapshot_id = $3::bigint,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND status = 'pending_approval'`,
        tid,
        campaign.id,
        snapshot.id,
      );
      await writeCampaignTransitionAudit(tx, {
        tenantId: tid,
        actorUid,
        actorRole: null,
        campaignId: campaign.id,
        previousStatus: 'pending_approval',
        nextStatus: 'dry_run',
        reason: 'audience_rematerialized_before_approval',
        details: { withdrawn_material_hash: campaign.approval_material_hash || null, new_snapshot_id: String(snapshot.id) },
      });
    } else {
      await tx.$executeRawUnsafe(
        `UPDATE engagement_campaigns
            SET current_audience_snapshot_id = $3::bigint,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tid,
        campaign.id,
        snapshot.id,
      );
    }

    return { snapshot, counts, recipients: inserted };
```

- [ ] **Step 6: Replace `updateCampaignStatus` with `applyCampaignTransition`**

```js
const TRANSITION_RETURNING = `
      RETURNING id, tenant_id, campaign_type, objective, status, template_id,
                channels, schedule_policy, rate_policy, audience_kind,
                approval_required_role, submitted_by, submitted_at,
                approved_by, approved_at, scheduled_at, frozen_audience_hash,
                current_audience_snapshot_id, approval_material,
                approval_material_hash, approved_material_hash, created_at, updated_at`;

// One status transition plus its audit row, inside the caller's tenant tx.
// `material` is supplied by submit (the reviewer-facing material and hashes);
// approve stamps the approved hash from the stored submitted hash.
async function applyCampaignTransition(tx, {
  tenantId, campaign, nextStatus, actorUid, actorRole, reason, material = null, details = null,
}) {
  const transitioned = await tx.$queryRawUnsafe(
    `UPDATE engagement_campaigns
        SET status = $4::varchar,
            submitted_by = CASE WHEN $4::varchar = 'pending_approval' THEN $5::uuid ELSE submitted_by END,
            submitted_at = CASE WHEN $4::varchar = 'pending_approval' THEN NOW() ELSE submitted_at END,
            approval_material = CASE WHEN $4::varchar = 'pending_approval' THEN $6::jsonb ELSE approval_material END,
            approval_material_hash = CASE WHEN $4::varchar = 'pending_approval' THEN $7::varchar ELSE approval_material_hash END,
            frozen_audience_hash = CASE WHEN $4::varchar = 'pending_approval' THEN $8::varchar ELSE frozen_audience_hash END,
            approved_by = CASE WHEN $4::varchar = 'scheduled' THEN $5::uuid ELSE approved_by END,
            approved_at = CASE WHEN $4::varchar = 'scheduled' THEN NOW() ELSE approved_at END,
            approved_material_hash = CASE WHEN $4::varchar = 'scheduled' THEN approval_material_hash ELSE approved_material_hash END,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $3::varchar
      ${TRANSITION_RETURNING}`,
    tenantId,
    campaign.id,
    campaign.status,
    nextStatus,
    uuidOrNull(actorUid),
    material ? JSON.stringify(material.body) : null,
    material ? material.hash : null,
    material ? material.audienceHash : null,
  );
  if (!transitioned[0]) {
    throw AppError.conflict(
      'Campaign status changed before the transition completed',
      'ENGAGEMENT_CAMPAIGN_TRANSITION_CONFLICT',
    );
  }
  await writeCampaignTransitionAudit(tx, {
    tenantId,
    actorUid,
    actorRole,
    campaignId: campaign.id,
    previousStatus: campaign.status,
    nextStatus,
    reason,
    details,
  });
  return jsonReady(transitioned[0]);
}
```

- [ ] **Step 7: `submitCampaignForApproval`**

```js
export async function submitCampaignForApproval({ tenantId, campaignId, actorUid = null, actorRole = null, reason = null }) {
  const submitterUid = uuidOrNull(actorUid);
  if (!submitterUid) {
    throw AppError.forbidden(
      'Authenticated submitter identity is required',
      'ENGAGEMENT_SUBMITTER_IDENTITY_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (campaign.status !== 'dry_run') {
      throw AppError.invalidTransition(campaign.status, 'pending_approval', ['dry_run']);
    }
    const live = await loadApprovalMaterial(tx, tid, campaign);
    if (!live.snapshot || live.snapshot.snapshot_kind !== 'materialized' || live.recipients.length === 0) {
      throw AppError.badRequest(
        'Campaign audience must be materialized before submission so the approval can bind it',
        'ENGAGEMENT_AUDIENCE_NOT_MATERIALIZED',
      );
    }
    return applyCampaignTransition(tx, {
      tenantId: tid,
      campaign,
      nextStatus: 'pending_approval',
      actorUid: submitterUid,
      actorRole,
      reason,
      material: { body: live.material, hash: live.hash, audienceHash: live.material.audience.recipients_hash },
      details: { approval_material_hash: live.hash },
    });
  });
}
```

- [ ] **Step 8: `approveCampaign`**

```js
export async function approveCampaign({ tenantId, campaignId, actorUid = null, actorRole = null, reason = null }) {
  const tid = requireTenantId(tenantId);
  const role = String(actorRole || '').toUpperCase();
  const approverUid = uuidOrNull(actorUid);
  const approvalReason = approvalReasonText(reason);
  const outcome = await setTenantTx(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (campaign.status !== 'pending_approval') {
      throw AppError.invalidTransition(campaign.status, 'scheduled', ['pending_approval']);
    }
    const allowed = campaign.approval_required_role === 'admin_quality'
      ? BROAD_APPROVAL_ROLES
      : CARE_TEAM_APPROVAL_ROLES;
    if (!allowed.has(role)) {
      throw AppError.forbidden(
        'This role cannot approve the requested engagement campaign',
        'ENGAGEMENT_APPROVAL_FORBIDDEN',
      );
    }
    if (!approverUid) {
      throw AppError.forbidden(
        'Authenticated approver identity is required',
        'ENGAGEMENT_APPROVER_IDENTITY_REQUIRED',
      );
    }
    if (!campaign.submitted_by) {
      throw AppError.forbidden(
        'Campaign submission identity is missing',
        'ENGAGEMENT_SUBMITTER_IDENTITY_MISSING',
      );
    }
    if (String(campaign.submitted_by).toLowerCase() === approverUid.toLowerCase()) {
      throw AppError.forbidden(
        'Campaign submitters cannot approve their own campaign',
        'ENGAGEMENT_SELF_APPROVAL_FORBIDDEN',
      );
    }
    if (!approvalReason) {
      throw AppError.badRequest(
        'Approval reason is required',
        'ENGAGEMENT_APPROVAL_REASON_REQUIRED',
      );
    }
    const live = await loadApprovalMaterial(tx, tid, campaign);
    if (!campaign.approval_material_hash || live.hash !== campaign.approval_material_hash) {
      const details = materialMismatchDetails(campaign, live);
      await resetCampaignToDraft(tx, {
        tenantId: tid,
        campaign,
        actorUid: approverUid,
        actorRole,
        reason: campaign.approval_material_hash ? 'approval_material_changed' : 'approval_material_missing',
        details,
      });
      return { mismatch: details };
    }
    const row = await applyCampaignTransition(tx, {
      tenantId: tid,
      campaign,
      nextStatus: 'scheduled',
      actorUid: approverUid,
      actorRole,
      reason: approvalReason,
      details: { approved_material_hash: live.hash },
    });
    return { row };
  });
  if (outcome.mismatch) {
    throw AppError.conflict(
      'Campaign material changed since submission; the campaign has been returned to draft for re-approval',
      'ENGAGEMENT_APPROVAL_MATERIAL_CHANGED',
      outcome.mismatch,
    );
  }
  return outcome.row;
}
```

- [ ] **Step 9: `queueDueCampaignRecipients` selection**

Replace the `setTenant(..., { readOnly: true })` block that returns `recipients` with:

```js
  const selection = await setTenantTx(tid, async (tx) => {
    const campaign = await loadCampaignContext(tx, tid, campaignId);
    if (!['scheduled', 'running'].includes(campaign.status)) {
      throw AppError.badRequest('Campaign must be approved before queueing recipients', 'ENGAGEMENT_NOT_APPROVED');
    }
    const live = await loadApprovalMaterial(tx, tid, campaign);
    if (!campaign.approved_material_hash || live.hash !== campaign.approved_material_hash) {
      const details = materialMismatchDetails(campaign, live);
      const code = campaign.approved_material_hash
        ? 'ENGAGEMENT_APPROVAL_MATERIAL_CHANGED'
        : 'ENGAGEMENT_APPROVAL_MATERIAL_MISSING';
      await resetCampaignToDraft(tx, {
        tenantId: tid,
        campaign,
        actorUid: null,
        actorRole: 'system',
        reason: campaign.approved_material_hash ? 'approval_material_changed' : 'approval_material_missing',
        details,
      });
      return { mismatch: { code, details } };
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, campaign_id, audience_snapshot_id, patient_uid,
              consent_id, required_consent_type, channel, contact_route, due_at,
              status, variables, idempotency_key
         FROM engagement_campaign_recipients
        WHERE tenant_id = $1::uuid
          AND campaign_id = $2::bigint
          AND audience_snapshot_id = $4::bigint
          AND status = 'eligible'
          AND due_at <= NOW()
        ORDER BY due_at ASC, id ASC
        LIMIT $3::int`,
      tid,
      campaign.id,
      boundedLimit,
      campaign.current_audience_snapshot_id,
    );
    return { recipients: rows };
  });
  if (selection.mismatch) {
    logger.warn('Engagement campaign approval no longer matches its material; returned to draft', {
      campaignId,
      code: selection.mismatch.code,
      changedSections: selection.mismatch.details.changed_sections,
    });
    throw AppError.conflict(
      selection.mismatch.code === 'ENGAGEMENT_APPROVAL_MATERIAL_MISSING'
        ? 'Campaign approval predates material binding; the campaign has been returned to draft for re-approval'
        : 'Campaign material changed after approval; the campaign has been returned to draft for re-approval',
      selection.mismatch.code,
      selection.mismatch.details,
    );
  }
  const recipients = selection.recipients;
```

- [ ] **Step 10: Existing suites green, lint, commit**

```bash
npm test -- --runTestsByPath src/tests/unit/campaignApprovalMaterial.test.js src/tests/unit/engagementCampaignService.test.js
DATABASE_URL=<base>/vh_dq16 npm test -- --runTestsByPath src/tests/engagement-campaigns.deep.test.js src/tests/engagement-list-endpoints.deep.test.js
node node_modules/eslint/bin/eslint.js --max-warnings=0 src/services/engagement/engagementCampaignService.js src/routes/engagement/engagementListQueries.js
git add src/services/engagement/engagementCampaignService.js
git commit -m "fix(engagement): bind campaign approval to its material at submit, approve, materialize and queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Expected: the existing deep test still passes end to end, including the second queue call returning `{ claimed: 0, queued: 0, suppressed: 0, failed: 0 }` after a real dispatch.

---

### Task 5: Deep-test extensions

**Files:**
- Modify: `apps/backend/src/tests/engagement-campaigns.deep.test.js`

- [ ] **Step 1: Extend the happy path**

After the `approvalRows` assertion, add:
```js
    const materialRows = await prisma.$queryRawUnsafe(
      `SELECT approval_material_hash, approved_material_hash, frozen_audience_hash, approval_material
         FROM engagement_campaigns
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      campaign.id,
    );
    expect(materialRows[0].approval_material_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(materialRows[0].approved_material_hash).toBe(materialRows[0].approval_material_hash);
    expect(materialRows[0].frozen_audience_hash).toBe(materialRows[0].approval_material.audience.recipients_hash);
    expect(materialRows[0].approval_material.audience.recipient_count).toBe(4);
```

- [ ] **Step 2: Add a helper that drives a campaign to approval, and four tests**

Add inside the `d(...)` block, before the closing:

```js
  async function approvedCampaign() {
    await cleanup();
    const campaign = await seedCampaign();
    const candidates = PATIENTS.map(([patientUid, _phone, name]) => ({
      patient_uid: patientUid,
      channel: 'sms',
      due_at: new Date(Date.now() - 60_000).toISOString(),
      variables: { first_name: name.split(' ')[1], appointment_window: 'tomorrow morning' },
    }));
    const input = { patients: candidates, cohort_source: { source_tables: ['users', 'patient_consents'] } };
    await dryRunCampaign({ tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID });
    await materializeCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID });
    await submitCampaignForApproval({ tenantId: TENANT_ID, campaignId: campaign.id, actorUid: ACTOR_UID, actorRole: 'DOCTOR' });
    await approveCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorUid: APPROVER_UID,
      actorRole: 'DOCTOR',
      reason: 'Reviewed',
    });
    return { campaign, input };
  }

  async function campaignState(campaignId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, submitted_by::text, approved_by::text, approval_material_hash, approved_material_hash, frozen_audience_hash
         FROM engagement_campaigns WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      campaignId,
    );
    return rows[0];
  }

  async function lastTransitionAudit(campaignId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT metadata FROM audit_logs
        WHERE action = 'ENGAGEMENT_CAMPAIGN_STATUS_CHANGED' AND resource = 'engagement_campaign'
          AND resource_id = $1 AND metadata->>'tenant_id' = $2
        ORDER BY id DESC LIMIT 1`,
      String(campaignId),
      TENANT_ID,
    );
    return rows[0]?.metadata;
  }

  it('refuses submission until the audience is materialized, and locks the audience once approved', async () => {
    await cleanup();
    const campaign = await seedCampaign();
    const candidates = PATIENTS.map(([patientUid, _phone, name]) => ({
      patient_uid: patientUid,
      channel: 'sms',
      due_at: new Date(Date.now() - 60_000).toISOString(),
      variables: { first_name: name.split(' ')[1], appointment_window: 'tomorrow morning' },
    }));
    const input = { patients: candidates, cohort_source: { source_tables: ['users', 'patient_consents'] } };
    await dryRunCampaign({ tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID });

    await expect(submitCampaignForApproval({
      tenantId: TENANT_ID, campaignId: campaign.id, actorUid: ACTOR_UID, actorRole: 'DOCTOR',
    })).rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_AUDIENCE_NOT_MATERIALIZED' });

    await materializeCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID });
    await submitCampaignForApproval({ tenantId: TENANT_ID, campaignId: campaign.id, actorUid: ACTOR_UID, actorRole: 'DOCTOR' });
    await approveCampaign({
      tenantId: TENANT_ID, campaignId: campaign.id, actorUid: APPROVER_UID, actorRole: 'DOCTOR', reason: 'Reviewed',
    });

    await expect(materializeCampaignRecipients({
      tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID,
    })).rejects.toMatchObject({ statusCode: 409, code: 'ENGAGEMENT_APPROVAL_LOCKED' });
    expect((await campaignState(campaign.id)).status).toBe('scheduled');
  });

  it('returns a campaign to draft when its material changes between submission and approval', async () => {
    await cleanup();
    const campaign = await seedCampaign();
    const candidates = PATIENTS.map(([patientUid, _phone, name]) => ({
      patient_uid: patientUid,
      channel: 'sms',
      due_at: new Date(Date.now() - 60_000).toISOString(),
      variables: { first_name: name.split(' ')[1], appointment_window: 'tomorrow morning' },
    }));
    const input = { patients: candidates, cohort_source: { source_tables: ['users', 'patient_consents'] } };
    await dryRunCampaign({ tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID });
    await materializeCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, input, actorUid: ACTOR_UID });
    await submitCampaignForApproval({ tenantId: TENANT_ID, campaignId: campaign.id, actorUid: ACTOR_UID, actorRole: 'DOCTOR' });

    await prisma.$executeRawUnsafe(
      `UPDATE engagement_campaigns SET schedule_policy = '{"window":"evening"}'::jsonb WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      campaign.id,
    );

    await expect(approveCampaign({
      tenantId: TENANT_ID, campaignId: campaign.id, actorUid: APPROVER_UID, actorRole: 'DOCTOR', reason: 'Reviewed',
    })).rejects.toMatchObject({ statusCode: 409, code: 'ENGAGEMENT_APPROVAL_MATERIAL_CHANGED' });

    expect(await campaignState(campaign.id)).toEqual(expect.objectContaining({
      status: 'draft', submitted_by: null, approved_by: null,
      approval_material_hash: null, approved_material_hash: null, frozen_audience_hash: null,
    }));
    expect(await lastTransitionAudit(campaign.id)).toEqual(expect.objectContaining({
      previous_status: 'pending_approval',
      next_status: 'draft',
      reason: 'approval_material_changed',
      changed_sections: ['campaign.schedule_policy'],
    }));
  });

  it('cannot dispatch an approved campaign whose material was edited afterwards', async () => {
    const { campaign } = await approvedCampaign();
    await prisma.$executeRawUnsafe(
      `UPDATE engagement_campaigns SET rate_policy = '{"per_patient_cooldown_hours":72}'::jsonb WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      campaign.id,
    );

    await expect(queueDueCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, limit: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ENGAGEMENT_APPROVAL_MATERIAL_CHANGED' });

    const recipientStatuses = await prisma.$queryRawUnsafe(
      `SELECT status, COUNT(*)::int AS count FROM engagement_campaign_recipients
        WHERE tenant_id = $1::uuid AND campaign_id = $2::bigint GROUP BY status ORDER BY status`,
      TENANT_ID,
      campaign.id,
    );
    expect(recipientStatuses).toEqual([{ status: 'eligible', count: 1 }, { status: 'suppressed', count: 3 }]);
    const outbox = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM notification_outbox WHERE payload->>'campaign_id' = $1`,
      String(campaign.id),
    );
    expect(outbox[0].count).toBe(0);
    expect((await campaignState(campaign.id)).status).toBe('draft');
    expect(await lastTransitionAudit(campaign.id)).toEqual(expect.objectContaining({
      previous_status: 'scheduled',
      next_status: 'draft',
      reason: 'approval_material_changed',
      changed_sections: ['campaign.rate_policy'],
    }));

    await expect(queueDueCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, limit: 10 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_NOT_APPROVED' });
  });

  it('never dispatches a recipient attached to a snapshot other than the approved one', async () => {
    const { campaign } = await approvedCampaign();
    const foreignSnapshot = await prisma.$queryRawUnsafe(
      `INSERT INTO engagement_audience_snapshots
         (tenant_id, campaign_id, snapshot_kind, cohort_source, cohort_hash, materialized_count, eligible_count, suppressed_count)
       VALUES ($1::uuid, $2::bigint, 'materialized', '{}'::jsonb, 'foreign', 1, 1, 0)
       RETURNING id`,
      TENANT_ID,
      campaign.id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO engagement_campaign_recipients
         (tenant_id, campaign_id, audience_snapshot_id, patient_uid, required_consent_type, channel,
          contact_route, due_at, status, idempotency_key, variables, updated_at)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, 'care_reminder_whatsapp', 'sms',
               '+919000009911', NOW() - INTERVAL '1 minute', 'eligible', $5, '{}'::jsonb, NOW())`,
      TENANT_ID,
      campaign.id,
      foreignSnapshot[0].id,
      PATIENT_ELIGIBLE,
      `${campaign.id}:foreign:${PATIENT_ELIGIBLE}`,
    );

    const queued = await queueDueCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, limit: 10 });
    expect(queued).toEqual({ claimed: 1, queued: 1, suppressed: 0, failed: 0 });
    const foreign = await prisma.$queryRawUnsafe(
      `SELECT status FROM engagement_campaign_recipients WHERE tenant_id = $1::uuid AND idempotency_key = $2`,
      TENANT_ID,
      `${campaign.id}:foreign:${PATIENT_ELIGIBLE}`,
    );
    expect(foreign[0].status).toBe('eligible');
  });
```

- [ ] **Step 3: Run the deep test; fix until green; commit**

Run: `DATABASE_URL=<base>/vh_dq16 npm test -- --runTestsByPath src/tests/engagement-campaigns.deep.test.js 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕|●.*›"`
Expected: 5 passed.

```bash
git add src/tests/engagement-campaigns.deep.test.js
git commit -m "test(engagement): prove approval binds the material and fails closed on edits

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Mutation tests, gates

- [ ] **Step 1: Mutation A** — in `queueDueCampaignRecipients`, replace `live.hash !== campaign.approved_material_hash` with `false`; run the deep test; expect "cannot dispatch an approved campaign whose material was edited afterwards" to FAIL; `git checkout -- src/services/engagement/engagementCampaignService.js`.
- [ ] **Step 2: Mutation B** — remove `AND audience_snapshot_id = $4::bigint` from the due SELECT (and the 4th argument); expect "never dispatches a recipient attached to a snapshot other than the approved one" to FAIL; restore.
- [ ] **Step 3: Mutation C** — in `campaignApprovalMaterial.js` add `status: text(row.status)` to `recipientIdentity`; expect the unit test's dispatch-field cases to FAIL AND the deep happy path's second queue call to FAIL; restore.
- [ ] **Step 4: Gates** — `npm run lint` (rc 0), `DATABASE_URL=<base>/vh_dq16 node scripts/check-schema-drift.mjs`, `npm run db:contracts`, `npm run openapi:check`, `node ../../scripts/ci/check-migration-immutability.mjs`, `node ../../scripts/ci/check-migration-session-guc.mjs`, `git status` clean.

---

### Task 7: Marker, push, draft PR, hand-back

```bash
git commit --allow-empty -m "ci: run the full canonical gate for the approval material binding [full-ci]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u github fix/engagement-campaign-approval-material-binding
git push origin fix/engagement-campaign-approval-material-binding
gh pr create -R Bahuleyandr/VH-Health-Platform --draft --base main --head fix/engagement-campaign-approval-material-binding --title "fix(engagement): bind campaign approval to the approved material (OPEN-16)" --body-file <scratchpad>/o16/pr-body.md
```
Report `Merge Gate` / `Full Merge Gate` by name with the head SHA to dev-ea; do not merge, mark ready or delete; drop `vh_dq16` once gates are terminal.
