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
const snapshot = {
  id: 9,
  snapshot_kind: 'materialized',
  cohort_hash: 'abc123',
  materialized_count: 2
};
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
const baseHash = () =>
  hashApprovalMaterial(buildApprovalMaterial({ campaign, snapshot, recipients }));
const hashWith = ({
  campaign: c = campaign,
  snapshot: s = snapshot,
  recipients: r = recipients
} = {}) => hashApprovalMaterial(buildApprovalMaterial({ campaign: c, snapshot: s, recipients: r }));

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
    const reversedRecipients = [...recipients]
      .reverse()
      .map(row => Object.fromEntries(Object.entries(row).reverse()));
    expect(hashWith({ campaign: shuffledCampaign, recipients: reversedRecipients })).toBe(
      baseHash()
    );
  });

  it('normalises patient uid case and Date/string due_at to one identity', () => {
    const a = recipientIdentity(recipients[0]);
    const b = recipientIdentity({
      ...recipients[0],
      patient_uid: recipients[0].patient_uid.toLowerCase(),
      due_at: '2026-09-04T09:00:00.000Z'
    });
    expect(a).toEqual(b);
    expect(a.due_at).toBe('2026-09-04T09:00:00.000Z');
    expect(a.patient_uid).toBe('00000000-0000-4000-8000-00000000e912');
  });
});

describe('every field a reviewer approves moves the hash', () => {
  it.each([
    [
      'campaign.objective',
      c => {
        c.objective = 'Different purpose';
      }
    ],
    [
      'campaign.campaign_type',
      c => {
        c.campaign_type = 'no_show_recall';
      }
    ],
    [
      'campaign.audience_kind',
      c => {
        c.audience_kind = 'broad';
      }
    ],
    [
      'campaign.approval_required_role',
      c => {
        c.approval_required_role = 'admin_quality';
      }
    ],
    [
      'campaign.channels',
      c => {
        c.channels = ['sms', 'push', 'email'];
      }
    ],
    [
      'campaign.schedule_policy',
      c => {
        c.schedule_policy = { window: 'evening' };
      }
    ],
    [
      'campaign.rate_policy',
      c => {
        c.rate_policy = { per_patient_cooldown_hours: 48 };
      }
    ],
    [
      'campaign.scheduled_at',
      c => {
        c.scheduled_at = '2026-09-05T09:00:00.000Z';
      }
    ],
    [
      'template.engagement_template_id',
      c => {
        c.template_id = 8;
      }
    ],
    [
      'template.notification_template_id',
      c => {
        c.notification_template_id = 4;
      }
    ],
    [
      'template.channel',
      c => {
        c.template_channel = 'whatsapp';
      }
    ],
    [
      'template.allowed_variables',
      c => {
        c.allowed_variables = ['first_name'];
      }
    ],
    [
      'template.phi_classification',
      c => {
        c.phi_classification = 'operational';
      }
    ],
    [
      'template.locale',
      c => {
        c.template_locale = 'ta-IN';
      }
    ],
    [
      'template.title_template',
      c => {
        c.title_template = 'Reminder';
      }
    ],
    [
      'template.message_template',
      c => {
        c.message_template = 'Hello {{first_name}}';
      }
    ],
    [
      'template.notification_type',
      c => {
        c.notification_type = 'general';
      }
    ]
  ])('%s', (_label, mutate) => {
    const mutated = clone(campaign);
    mutate(mutated);
    expect(hashWith({ campaign: mutated })).not.toBe(baseHash());
  });

  it.each([
    [
      'audience.snapshot_id',
      s => {
        s.id = 10;
      }
    ],
    [
      'audience.snapshot_kind',
      s => {
        s.snapshot_kind = 'dry_run';
      }
    ],
    [
      'audience.cohort_hash',
      s => {
        s.cohort_hash = 'def456';
      }
    ]
  ])('%s', (_label, mutate) => {
    const mutated = clone(snapshot);
    mutate(mutated);
    expect(hashWith({ snapshot: mutated })).not.toBe(baseHash());
  });

  it.each([
    [
      'a recipient added',
      r => {
        r.push({ ...clone(r[0]), idempotency_key: '42:p3:sms', patient_uid: 'p3' });
      }
    ],
    [
      'a recipient removed',
      r => {
        r.pop();
      }
    ],
    [
      'recipient.patient_uid',
      r => {
        r[0].patient_uid = '00000000-0000-4000-8000-00000000e999';
      }
    ],
    [
      'recipient.channel',
      r => {
        r[0].channel = 'whatsapp';
      }
    ],
    [
      'recipient.due_at',
      r => {
        r[0].due_at = '2026-09-06T09:00:00.000Z';
      }
    ],
    [
      'recipient.required_consent_type',
      r => {
        r[0].required_consent_type = 'care_reminder_sms';
      }
    ],
    [
      'recipient.variables',
      r => {
        r[0].variables = { first_name: 'Someone else', appointment_window: 'tomorrow' };
      }
    ],
    [
      'recipient.idempotency_key',
      r => {
        r[0].idempotency_key = '42:other:sms';
      }
    ]
  ])('%s', (_label, mutate) => {
    const mutated = clone(recipients);
    mutate(mutated);
    expect(hashWith({ recipients: mutated })).not.toBe(baseHash());
  });
});

describe('nothing the dispatch path writes moves the hash', () => {
  it.each([
    [
      'recipient.status',
      r => {
        r[0].status = 'queued';
        r[1].status = 'failed';
      }
    ],
    [
      'recipient.suppression_reason',
      r => {
        r[0].suppression_reason = 'quiet_hours';
      }
    ],
    [
      'recipient.consent_id',
      r => {
        r[0].consent_id = 99;
      }
    ],
    [
      'recipient.contact_route',
      r => {
        r[0].contact_route = '+910000000000';
      }
    ],
    [
      'recipient.outbox_id',
      r => {
        r[0].outbox_id = 1234;
      }
    ],
    [
      'recipient.delivery_metadata',
      r => {
        r[0].delivery_metadata = { outbox_type: 'engagement_campaign' };
      }
    ],
    [
      'recipient.retry_count',
      r => {
        r[0].retry_count = 3;
      }
    ],
    [
      'recipient timestamps',
      r => {
        r[0].queued_at = '2026-09-04T09:01:00.000Z';
        r[0].sent_at = '2026-09-04T09:02:00.000Z';
        r[0].last_consent_checked_at = '2026-09-04T09:00:30.000Z';
      }
    ]
  ])('%s', (_label, mutate) => {
    const mutated = clone(recipients);
    mutate(mutated);
    expect(hashWith({ recipients: mutated })).toBe(baseHash());
  });

  it.each([
    [
      'campaign.status',
      c => {
        c.status = 'running';
      }
    ],
    [
      'campaign actors and timestamps',
      c => {
        c.approved_by = 'x';
        c.approved_at = 'y';
        c.updated_at = 'z';
        c.submitted_by = null;
      }
    ],
    [
      'campaign.current_audience_snapshot_id',
      c => {
        c.current_audience_snapshot_id = 77;
      }
    ]
  ])('%s', (_label, mutate) => {
    const mutated = clone(campaign);
    mutate(mutated);
    expect(hashWith({ campaign: mutated })).toBe(baseHash());
  });

  it('ignores snapshot counts, which dispatch verdicts change', () => {
    expect(hashWith({ snapshot: { ...snapshot, materialized_count: 99, eligible_count: 1 } })).toBe(
      baseHash()
    );
  });

  it('keeps the identity and dispatch field lists disjoint and covers every column the queue path writes', () => {
    expect(
      RECIPIENT_IDENTITY_FIELDS.filter(field => RECIPIENT_DISPATCH_FIELDS.includes(field))
    ).toEqual([]);
    const source = readFileSync(
      fileURLToPath(
        new URL('../../services/engagement/engagementCampaignService.js', import.meta.url)
      ),
      'utf8'
    );
    const updates = [
      ...source.matchAll(/UPDATE engagement_campaign_recipients\s+SET([\s\S]*?)\n\s*WHERE/g)
    ];
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
    const after = buildApprovalMaterial({
      campaign: edited,
      snapshot,
      recipients: recipients.slice(0, 1)
    });
    expect(describeMaterialDifference(before, after)).toEqual([
      'audience.recipient_count',
      'audience.recipients_hash',
      'campaign.schedule_policy',
      'template.title_template'
    ]);
    expect(describeMaterialDifference(before, before)).toEqual([]);
    // With no stored material at all (a legacy row), whole sections differ.
    expect(describeMaterialDifference(null, after)).toEqual([
      'audience',
      'campaign',
      'template',
      'version'
    ]);
  });
});
