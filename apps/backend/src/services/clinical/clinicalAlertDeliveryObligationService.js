import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  resolveClinicalAlertRecipients,
} from '../../utils/notifications/clinicalAlertFanout.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RETRY_DELAY_MINUTES = 5;
const RECOVERY_REASON_MIN = 10;
const RECOVERY_REASON_MAX = 1000;
const RECOVERY_CASE_SOURCE_TABLE = 'clinical_alert_delivery_recovery_cases';

export const CLINICAL_ALERT_RECOVERY_TASK_CONTRACT =
  'clinical_alert_delivery_recovery_v1';

export const CLINICAL_ALERT_RECOVERY_RULES = Object.freeze({
  manual_hold: Object.freeze({
    ruleCode: 'clinical_alert_delivery_manual_hold_review',
    targetMinutes: 15,
    title: 'Clinical alert recovery requires source review',
  }),
  recipient_coverage: Object.freeze({
    ruleCode: 'clinical_alert_delivery_recipient_coverage',
    targetMinutes: 15,
    title: 'Clinical alert has no deliverable clinical recipient',
  }),
});

export const CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS = Object.freeze({
  en: Object.freeze({
    title: 'Clinical alert delivery recovery is overdue',
    manualHoldBody:
      'An immutable held clinical alert requires governed source review and supersession.',
    recipientCoverageBody:
      'A clinical alert still has no active duty-doctor or doctor-tier recipient.',
  }),
  hi: Object.freeze({
    title: 'क्लिनिकल अलर्ट डिलीवरी रिकवरी की समय-सीमा बीत गई है',
    manualHoldBody:
      'अपरिवर्तनीय रूप से रोके गए क्लिनिकल अलर्ट के लिए नियंत्रित स्रोत समीक्षा और प्रतिस्थापन आवश्यक है।',
    recipientCoverageBody:
      'किसी क्लिनिकल अलर्ट के लिए अभी भी कोई सक्रिय ड्यूटी डॉक्टर या डॉक्टर-स्तर का प्राप्तकर्ता उपलब्ध नहीं है।',
  }),
  ta: Object.freeze({
    title: 'மருத்துவ எச்சரிக்கை வழங்கல் மீட்பு காலக்கெடுவை கடந்துவிட்டது',
    manualHoldBody:
      'மாற்ற இயலாமல் நிறுத்திவைக்கப்பட்ட மருத்துவ எச்சரிக்கைக்கு நிர்வகிக்கப்பட்ட மூல ஆய்வும் மாற்றுப் பதிவும் தேவை.',
    recipientCoverageBody:
      'ஒரு மருத்துவ எச்சரிக்கைக்கு இன்னும் செயலில் உள்ள பணிப்பொறுப்பு மருத்துவர் அல்லது மருத்துவர்-நிலை பெறுநர் இல்லை.',
  }),
  te: Object.freeze({
    title: 'క్లినికల్ అలర్ట్ డెలివరీ పునరుద్ధరణ గడువు దాటింది',
    manualHoldBody:
      'మార్చలేని విధంగా హోల్డ్ చేసిన క్లినికల్ అలర్ట్‌కు నియంత్రిత మూల సమీక్ష మరియు ప్రత్యామ్నాయ నమోదు అవసరం.',
    recipientCoverageBody:
      'ఒక క్లినికల్ అలర్ట్‌కు ఇప్పటికీ క్రియాశీల డ్యూటీ డాక్టర్ లేదా డాక్టర్-స్థాయి గ్రహీత లేరు.',
  }),
  ml: Object.freeze({
    title: 'ക്ലിനിക്കൽ അലർട്ട് ഡെലിവറി വീണ്ടെടുക്കലിന്റെ സമയപരിധി കഴിഞ്ഞു',
    manualHoldBody:
      'മാറ്റാനാവാതെ ഹോൾഡ് ചെയ്തിരിക്കുന്ന ക്ലിനിക്കൽ അലർട്ടിന് നിയന്ത്രിത ഉറവിട അവലോകനവും പകരം രേഖപ്പെടുത്തലും ആവശ്യമാണ്.',
    recipientCoverageBody:
      'ഒരു ക്ലിനിക്കൽ അലർട്ടിന് ഇപ്പോഴും സജീവ ഡ്യൂട്ടി ഡോക്ടറോ ഡോക്ടർ-തലത്തിലുള്ള സ്വീകർത്താവോ ഇല്ല.',
  }),
});

export const CLINICAL_ALERT_RECOVERY_SOURCE =
  'clinical-alert-delivery-obligation-recovery.v1';

export const CLINICAL_ALERT_RECIPIENT_POLICY = Object.freeze({
  version: 1,
  strategy: 'duty_doctor_then_doctor_tiers',
  primary_role: 'DUTY_DOCTOR',
  fallback_roles: Object.freeze([
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'RESIDENT',
  ]),
});

const FAILURE_SOURCE = Object.freeze({
  order_mar_schedule: 'clinical_orders',
  order_mar_carryover: 'clinical_orders',
  icu_mar_carryover_query: 'icu_admissions',
});

const FAILURE_INTENT_CONTRACT = Object.freeze({
  order_mar_schedule: Object.freeze({
    idField: 'order_id',
    failureStage: 'mar_schedule',
    sourceEventKey: (sourceId) => `clinical_orders:${sourceId}:mar_schedule_failed:alert`,
    templateVersion: 'clinical-alert-order-integration-failure.v1',
  }),
  order_mar_carryover: Object.freeze({
    idField: 'order_id',
    failureStage: 'mar_carryover',
    sourceEventKey: (sourceId) => `clinical_orders:${sourceId}:mar_carryover_failed:alert`,
    templateVersion: 'clinical-alert-order-integration-failure.v1',
  }),
  icu_mar_carryover_query: Object.freeze({
    idField: 'icu_admission_id',
    failureStage: null,
    sourceEventKey: (sourceId) => `icu_admissions:${sourceId}:icu.mar_carryover_failed:alert`,
    templateVersion: 'clinical-alert-icu-mar-carryover-failure.v1',
  }),
});

const HOLD_REASONS = Object.freeze({
  CLINICAL_ALERT_OBLIGATION_INTENT_INVALID:
    'The exact stored clinical alert intent is unavailable or malformed. No replacement alert was emitted.',
  CLINICAL_ALERT_OBLIGATION_POLICY_INVALID:
    'The stored recipient policy is not the governed duty-doctor policy. No replacement alert was emitted.',
  CLINICAL_ALERT_OBLIGATION_SOURCE_MISSING:
    'The source clinical record is unavailable for exact alert correlation. No replacement alert was emitted.',
  CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH:
    'The stored clinical alert intent does not match its source record. No replacement alert was emitted.',
});

const RECOVERY_CASE_STATUSES = new Set(['open', 'resolved']);
const RECOVERY_CASE_KINDS = new Set(Object.keys(CLINICAL_ALERT_RECOVERY_RULES));
const RECOVERY_ACTION_TYPES = new Set([
  'retry_delivery',
  'supersede_from_source',
  'system_delivery_recovered',
  'system_manual_hold',
]);

function recoveryEscalationLocale(value) {
  const locale = String(value || '').trim().toLowerCase().split(/[-_]/u)[0];
  return Object.hasOwn(CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS, locale)
    ? locale
    : 'en';
}

function recoveryEscalationPresentation(value, caseKind) {
  const locale = recoveryEscalationLocale(value);
  const presentation = CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS[locale];
  return Object.freeze({
    locale,
    title: presentation.title,
    body: caseKind === 'manual_hold'
      ? presentation.manualHoldBody
      : presentation.recipientCoverageBody,
  });
}

function requiredTenantId(value) {
  const tenantId = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(tenantId)) {
    throw AppError.badRequest(
      'Clinical alert recovery requires tenantId',
      'CLINICAL_ALERT_OBLIGATION_TENANT_REQUIRED',
    );
  }
  return tenantId;
}

function optionalUuid(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw AppError.internal(
      `Clinical alert recovery requires exact ${field}`,
      'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
    );
  }
  return normalized;
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw AppError.internal(
        'Clinical alert intent contains a non-finite number',
        'CLINICAL_ALERT_OBLIGATION_INTENT_INVALID',
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw AppError.internal(
    'Clinical alert intent contains an unsupported value',
    'CLINICAL_ALERT_OBLIGATION_INTENT_INVALID',
  );
}

function exactIntent(notification) {
  const raw = notification && typeof notification === 'object' ? notification : {};
  const data = canonicalize(raw.data || {});
  const type = String(raw.type || '').trim().toLowerCase();
  const channel = String(raw.channel || '').trim().toLowerCase();
  const title = String(raw.title || '').trim();
  const body = String(raw.body || '').trim();
  const sourceEventKey = String(
    raw.source_event_key || raw.sourceEventKey || data?.source_event_key || '',
  ).trim();
  const templateVersion = String(
    raw.template_version || raw.templateVersion || '',
  ).trim();
  if (
    type !== 'push'
    || channel !== 'push'
    || !title
    || !body
    || !sourceEventKey
    || sourceEventKey.length > 255
    || !templateVersion
    || templateVersion.length > 80
    || !data
    || typeof data !== 'object'
    || Array.isArray(data)
    || data.source_event_key !== sourceEventKey
    || typeof data.deep_link !== 'string'
    || !data.deep_link.startsWith('/')
  ) {
    throw AppError.internal(
      'Clinical alert recovery requires one exact actionable push intent',
      'CLINICAL_ALERT_OBLIGATION_INTENT_INVALID',
    );
  }
  return {
    type,
    channel,
    title,
    body,
    source_event_key: sourceEventKey,
    template_version: templateVersion,
    data,
  };
}

function exactRecipientPolicy(value = CLINICAL_ALERT_RECIPIENT_POLICY) {
  const policy = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = Array.isArray(policy.fallback_roles) ? policy.fallback_roles.map(String) : [];
  if (
    Number(policy.version) !== CLINICAL_ALERT_RECIPIENT_POLICY.version
    || policy.strategy !== CLINICAL_ALERT_RECIPIENT_POLICY.strategy
    || policy.primary_role !== CLINICAL_ALERT_RECIPIENT_POLICY.primary_role
    || fallback.length !== CLINICAL_ALERT_RECIPIENT_POLICY.fallback_roles.length
    || fallback.some((role, index) => (
      role !== CLINICAL_ALERT_RECIPIENT_POLICY.fallback_roles[index]
    ))
  ) {
    throw AppError.internal(
      'Clinical alert recovery recipient policy is not governed',
      'CLINICAL_ALERT_OBLIGATION_POLICY_INVALID',
    );
  }
  return {
    version: CLINICAL_ALERT_RECIPIENT_POLICY.version,
    strategy: CLINICAL_ALERT_RECIPIENT_POLICY.strategy,
    primary_role: CLINICAL_ALERT_RECIPIENT_POLICY.primary_role,
    fallback_roles: [...CLINICAL_ALERT_RECIPIENT_POLICY.fallback_roles],
  };
}

function sourceIdentity({ sourceTable, sourceId, failureKind }) {
  const source = String(sourceTable || '').trim();
  const id = String(sourceId || '').trim();
  const kind = String(failureKind || '').trim();
  if (
    FAILURE_SOURCE[kind] !== source
    || !POSITIVE_INT_RE.test(id)
  ) {
    throw AppError.internal(
      'Clinical alert recovery source is not a registered failure contract',
      'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
    );
  }
  return { sourceTable: source, sourceId: id, failureKind: kind };
}

function registeredSourceEventKey(source, supersedesObligationId = null) {
  const contract = FAILURE_INTENT_CONTRACT[source.failureKind];
  const base = contract?.sourceEventKey(source.sourceId) || '';
  return supersedesObligationId == null
    ? base
    : `${base}:supersession:${supersedesObligationId}`;
}

function assertRegisteredIntentContract(source, intent, supersedesObligationId = null) {
  const contract = FAILURE_INTENT_CONTRACT[source.failureKind];
  const expectedSupersedes = supersedesObligationId == null
    ? null
    : String(supersedesObligationId);
  if (
    !contract
    || intent.source_event_key !== registeredSourceEventKey(source, supersedesObligationId)
    || intent.template_version !== contract.templateVersion
    || String(intent.data?.[contract.idField] || '') !== source.sourceId
    || intent.data?.requires_doctor_authority !== true
    || (
      expectedSupersedes == null
        ? intent.data?.supersedes_obligation_id != null
        : String(intent.data?.supersedes_obligation_id || '') !== expectedSupersedes
    )
    || (
      contract.failureStage
      && intent.data?.failure_stage !== contract.failureStage
    )
  ) {
    throw AppError.internal(
      'Clinical alert intent does not match its registered failure contract',
      'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
    );
  }
}

function obligationKey(tenantId, sourceEventKey) {
  return createHash('sha256')
    .update(`${tenantId}:${sourceEventKey}`, 'utf8')
    .digest('hex');
}

function boundedLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function positiveId(value, field) {
  const text = String(value || '').trim();
  if (
    !POSITIVE_INT_RE.test(text)
    || BigInt(text) > POSTGRES_BIGINT_MAX
  ) {
    throw AppError.badRequest(
      `${field} must be a positive integer`,
      'CLINICAL_ALERT_RECOVERY_ID_INVALID',
    );
  }
  return text;
}

function apiId(value) {
  const text = String(value);
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) ? numeric : text;
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return apiId(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
  );
}

function recoveryCaseKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (!RECOVERY_CASE_KINDS.has(kind)) {
    throw AppError.badRequest(
      'Clinical alert recovery case kind is invalid',
      'CLINICAL_ALERT_RECOVERY_CASE_KIND_INVALID',
    );
  }
  return kind;
}

function recoveryCaseStatus(value) {
  if (value == null || value === '') return null;
  const status = String(value).trim().toLowerCase();
  if (!RECOVERY_CASE_STATUSES.has(status)) {
    throw AppError.badRequest(
      'Clinical alert recovery case status is invalid',
      'CLINICAL_ALERT_RECOVERY_CASE_STATUS_INVALID',
    );
  }
  return status;
}

function recoveryActionType(value) {
  const action = String(value || '').trim().toLowerCase();
  if (!RECOVERY_ACTION_TYPES.has(action)) {
    throw AppError.badRequest(
      'Clinical alert recovery action is invalid',
      'CLINICAL_ALERT_RECOVERY_ACTION_INVALID',
    );
  }
  return action;
}

function recoveryReason(value) {
  const reason = String(value || '').replace(/<[^>]*>/g, '').trim();
  if (reason.length < RECOVERY_REASON_MIN || reason.length > RECOVERY_REASON_MAX) {
    throw AppError.badRequest(
      `reason must be ${RECOVERY_REASON_MIN}-${RECOVERY_REASON_MAX} characters`,
      'CLINICAL_ALERT_RECOVERY_REASON_INVALID',
    );
  }
  return reason;
}

function recoveryIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_.:-]',
      'CLINICAL_ALERT_RECOVERY_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

function commandSha256(command) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(command)), 'utf8')
    .digest('hex');
}

function holdCode(error) {
  const code = String(error?.code || '');
  return Object.hasOwn(HOLD_REASONS, code) ? code : null;
}

export async function createClinicalAlertDeliveryObligationTx(tx, {
  tenantId,
  sourceTable,
  sourceId,
  failureKind,
  patientUid = null,
  encounterId = null,
  originActorUid = null,
  failureCode,
  recipientPolicy = CLINICAL_ALERT_RECIPIENT_POLICY,
  notificationIntent,
  supersedesObligationId = null,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Clinical alert delivery obligations require the failure transaction',
      'CLINICAL_ALERT_OBLIGATION_TRANSACTION_REQUIRED',
    );
  }
  const tid = requiredTenantId(tenantId);
  const source = sourceIdentity({ sourceTable, sourceId, failureKind });
  const intent = exactIntent(notificationIntent);
  const cleanSupersedesObligationId = supersedesObligationId == null
    ? null
    : positiveId(supersedesObligationId, 'supersedesObligationId');
  assertRegisteredIntentContract(source, intent, cleanSupersedesObligationId);
  const policy = exactRecipientPolicy(recipientPolicy);
  const cleanPatientUid = optionalUuid(patientUid, 'patient identity');
  const cleanEncounterId = optionalUuid(encounterId, 'encounter identity');
  const cleanOriginActorUid = optionalUuid(originActorUid, 'origin actor identity');
  const cleanFailureCode = String(failureCode || '').trim().slice(0, 120);
  if (!cleanFailureCode) {
    throw AppError.internal(
      'Clinical alert recovery requires a stable failure code',
      'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
    );
  }
  const key = obligationKey(tid, intent.source_event_key);

  const rows = await tx.$queryRawUnsafe(
    `WITH inserted AS (
       INSERT INTO clinical_alert_delivery_obligations
         (tenant_id, obligation_key, source_table, source_id, source_event_key,
          failure_kind, patient_uid, encounter_id, origin_actor_uid, failure_code,
          recipient_policy, notification_intent, supersedes_obligation_id)
       VALUES ($1::uuid, $2::char(64), $3::text, $4::text, $5::text,
               $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text,
               $11::jsonb, $12::jsonb, $13::bigint)
       ON CONFLICT (tenant_id, source_event_key) DO NOTHING
       RETURNING id, tenant_id, obligation_key, source_table, source_id,
                 source_event_key, failure_kind, patient_uid, encounter_id,
                 origin_actor_uid, failure_code, recipient_policy,
                 notification_intent, supersedes_obligation_id, status,
                 attempt_count, last_attempted_at, next_attempt_at,
                 last_error_code, completion_notification_outbox_id,
                 completion_notification_outbox_ids, completion_recipient_ids,
                 completion_evidence, completed_at, manual_hold_code,
                 manual_hold_reason, held_at, created_at, updated_at
     )
     SELECT inserted.id, inserted.tenant_id, inserted.obligation_key,
            inserted.source_table, inserted.source_id, inserted.source_event_key,
            inserted.failure_kind, inserted.patient_uid, inserted.encounter_id,
            inserted.origin_actor_uid, inserted.failure_code,
            inserted.recipient_policy, inserted.notification_intent,
            inserted.supersedes_obligation_id, inserted.status,
            inserted.attempt_count, inserted.last_attempted_at,
            inserted.next_attempt_at, inserted.last_error_code,
            inserted.completion_notification_outbox_id,
            inserted.completion_notification_outbox_ids,
            inserted.completion_recipient_ids, inserted.completion_evidence,
            inserted.completed_at, inserted.manual_hold_code,
            inserted.manual_hold_reason, inserted.held_at,
            inserted.created_at, inserted.updated_at
       FROM inserted
     UNION ALL
     SELECT existing.id, existing.tenant_id, existing.obligation_key,
            existing.source_table, existing.source_id, existing.source_event_key,
            existing.failure_kind, existing.patient_uid, existing.encounter_id,
            existing.origin_actor_uid, existing.failure_code,
            existing.recipient_policy, existing.notification_intent,
            existing.supersedes_obligation_id, existing.status,
            existing.attempt_count, existing.last_attempted_at,
            existing.next_attempt_at, existing.last_error_code,
            existing.completion_notification_outbox_id,
            existing.completion_notification_outbox_ids,
            existing.completion_recipient_ids, existing.completion_evidence,
            existing.completed_at, existing.manual_hold_code,
            existing.manual_hold_reason, existing.held_at,
            existing.created_at, existing.updated_at
       FROM clinical_alert_delivery_obligations existing
      WHERE existing.tenant_id = $1::uuid
        AND existing.source_event_key = $5::text
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    tid,
    key,
    source.sourceTable,
    source.sourceId,
    intent.source_event_key,
    source.failureKind,
    cleanPatientUid,
    cleanEncounterId,
    cleanOriginActorUid,
    cleanFailureCode,
    JSON.stringify(policy),
    JSON.stringify(intent),
    cleanSupersedesObligationId,
  );
  const obligation = rows[0];
  if (!obligation) {
    throw AppError.internal(
      'Clinical alert delivery obligation was not persisted',
      'CLINICAL_ALERT_OBLIGATION_MISSING',
    );
  }
  if (
    String(obligation.obligation_key) !== key
    || obligation.source_table !== source.sourceTable
    || obligation.source_id !== source.sourceId
    || obligation.failure_kind !== source.failureKind
    || String(obligation.supersedes_obligation_id || '')
      !== String(cleanSupersedesObligationId || '')
    || JSON.stringify(canonicalize(obligation.recipient_policy))
      !== JSON.stringify(canonicalize(policy))
    || JSON.stringify(canonicalize(obligation.notification_intent))
      !== JSON.stringify(canonicalize(intent))
  ) {
    throw AppError.conflict(
      'Clinical alert source identity already carries a different immutable intent',
      'CLINICAL_ALERT_OBLIGATION_INTENT_CONFLICT',
    );
  }
  return obligation;
}

export async function persistClinicalAlertFailureWithCanonical({
  tenantId,
  obligation,
  recordCanonical,
  transaction = setTenantTx,
} = {}) {
  const tid = requiredTenantId(tenantId);
  if (typeof recordCanonical !== 'function') {
    throw AppError.internal(
      'Clinical alert recovery requires a canonical failure recorder',
      'CLINICAL_ALERT_OBLIGATION_CANONICAL_REQUIRED',
    );
  }
  return transaction(tid, async (tx) => {
    const row = await createClinicalAlertDeliveryObligationTx(tx, {
      ...obligation,
      tenantId: tid,
    });
    const canonical = await recordCanonical(tx, row);
    if (!canonical) {
      throw AppError.internal(
        'Clinical alert failure canonical evidence was not persisted',
        'CLINICAL_ALERT_OBLIGATION_CANONICAL_MISSING',
      );
    }
    return { obligation: row, canonical };
  });
}

function storedIntent(row) {
  return exactIntent(row?.notification_intent);
}

function storedPolicy(row) {
  return exactRecipientPolicy(row?.recipient_policy);
}

async function assertSourceMatches(tx, row, intent) {
  assertRegisteredIntentContract({
    sourceTable: row.source_table,
    sourceId: row.source_id,
    failureKind: row.failure_kind,
  }, intent, row.supersedes_obligation_id);
  if (row.source_table === 'clinical_orders') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text, encounter_id::text
         FROM clinical_orders
        WHERE tenant_id = $1::uuid
          AND id::text = $2::text
        LIMIT 1
        FOR SHARE`,
      row.tenant_id,
      row.source_id,
    );
    const source = rows[0];
    if (!source) {
      throw AppError.internal(
        'Clinical alert obligation source order is missing',
        'CLINICAL_ALERT_OBLIGATION_SOURCE_MISSING',
      );
    }
    if (
      String(intent.data.order_id || '') !== String(source.id)
      || String(intent.data.patient_uid || '').toLowerCase()
        !== String(source.patient_uid || '').toLowerCase()
      || String(row.patient_uid || '').toLowerCase()
        !== String(source.patient_uid || '').toLowerCase()
      || intent.data.recovery_endpoint
        !== `/api/v1/emr/orders/${source.id}/retry-mar-scheduling`
      || intent.data.deep_link
        !== `/emr/orders/${source.patient_uid}?mar_recovery_order=${source.id}`
    ) {
      throw AppError.internal(
        'Clinical alert intent does not match its medication order',
        'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
      );
    }
    return;
  }

  if (row.source_table === 'icu_admissions') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text
         FROM icu_admissions
        WHERE tenant_id = $1::uuid
          AND id::text = $2::text
        LIMIT 1
        FOR SHARE`,
      row.tenant_id,
      row.source_id,
    );
    const source = rows[0];
    if (!source) {
      throw AppError.internal(
        'Clinical alert obligation source ICU admission is missing',
        'CLINICAL_ALERT_OBLIGATION_SOURCE_MISSING',
      );
    }
    if (
      String(intent.data.icu_admission_id || '') !== String(source.id)
      || String(intent.data.patient_uid || '').toLowerCase()
        !== String(source.patient_uid || '').toLowerCase()
      || String(row.patient_uid || '').toLowerCase()
        !== String(source.patient_uid || '').toLowerCase()
      || intent.data.deep_link
        !== `/emr/orders/${source.patient_uid}?icu_mar_review=${source.id}`
    ) {
      throw AppError.internal(
        'Clinical alert intent does not match its ICU admission',
        'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
      );
    }
    return;
  }

  throw AppError.internal(
    'Clinical alert obligation source type is unsupported',
    'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
  );
}

function assertObligationSourceIdentity(row, source) {
  if (
    String(row.patient_uid || '').toLowerCase()
      !== String(source.patient_uid || '').toLowerCase()
    || (
      row.encounter_id != null
      && String(row.encounter_id).toLowerCase()
        !== String(source.encounter_id || '').toLowerCase()
    )
  ) {
    throw AppError.conflict(
      'The held obligation identity does not match its current source record',
      'CLINICAL_ALERT_RECOVERY_SOURCE_IDENTITY_MISMATCH',
    );
  }
}

async function deriveSupersedingObligationTx(tx, row) {
  const source = sourceIdentity({
    sourceTable: row.source_table,
    sourceId: row.source_id,
    failureKind: row.failure_kind,
  });
  const sourceEventKey = registeredSourceEventKey(source, row.obligation_id);

  if (source.sourceTable === 'clinical_orders') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, order_number, order_type, priority, patient_uid::text,
              encounter_id::text, ordered_by::text
         FROM clinical_orders
        WHERE tenant_id = $1::uuid
          AND id::text = $2::text
        LIMIT 1
        FOR SHARE`,
      row.tenant_id,
      source.sourceId,
    );
    const order = rows[0];
    if (!order) {
      throw AppError.conflict(
        'The held clinical alert source order is still unavailable',
        'CLINICAL_ALERT_RECOVERY_SOURCE_UNAVAILABLE',
      );
    }
    assertObligationSourceIdentity(row, order);
    const stage = source.failureKind === 'order_mar_schedule'
      ? 'mar_schedule'
      : 'mar_carryover';
    const isSchedule = stage === 'mar_schedule';
    const intent = {
      type: 'push',
      channel: 'push',
      title: isSchedule
        ? 'Medication order has NO scheduled MAR doses'
        : 'ER medication did not carry into the ICU MAR',
      body: isSchedule
        ? `MAR scheduling FAILED for medication order ${order.order_number} — no doses are on the drug chart. Open the order and use Repair MAR; if the schedule definition is invalid, discontinue it and place a corrected CPOE order.`
        : `ER-to-ICU MAR carryover FAILED for medication order ${order.order_number}. Open the order and use Repair MAR; if the schedule definition is invalid, discontinue it and place a corrected CPOE order.`,
      source_event_key: sourceEventKey,
      template_version: 'clinical-alert-order-integration-failure.v1',
      data: {
        source_event_key: sourceEventKey,
        order_id: Number(order.id),
        order_number: order.order_number,
        order_type: order.order_type,
        priority: order.priority,
        patient_uid: order.patient_uid,
        failure_stage: stage,
        error_code: row.failure_code,
        recovery_endpoint: `/api/v1/emr/orders/${order.id}/retry-mar-scheduling`,
        deep_link: `/emr/orders/${order.patient_uid}?mar_recovery_order=${order.id}`,
        requires_doctor_authority: true,
        supersedes_obligation_id: String(row.obligation_id),
      },
    };
    return {
      sourceTable: source.sourceTable,
      sourceId: source.sourceId,
      failureKind: source.failureKind,
      patientUid: order.patient_uid,
      encounterId: order.encounter_id || null,
      originActorUid: order.ordered_by || null,
      failureCode: row.failure_code,
      notificationIntent: intent,
      supersedesObligationId: String(row.obligation_id),
    };
  }

  const rows = await tx.$queryRawUnsafe(
    `SELECT icu.id, icu.patient_uid::text,
            icu.admitting_doctor_uid::text AS origin_actor_uid,
            visit.id AS emergency_visit_id,
            visit.patient_uid::text AS visit_patient_uid,
            visit.encounter_id::text
       FROM icu_admissions icu
       JOIN emergency_visits visit
         ON visit.tenant_id = icu.tenant_id
        AND visit.id = icu.er_visit_id
      WHERE icu.tenant_id = $1::uuid
        AND icu.id::text = $2::text
      LIMIT 1
      FOR SHARE OF icu, visit`,
    row.tenant_id,
    source.sourceId,
  );
  const admission = rows[0];
  if (!admission) {
    throw AppError.conflict(
      'The held ICU alert source admission and emergency visit are unavailable',
      'CLINICAL_ALERT_RECOVERY_SOURCE_UNAVAILABLE',
    );
  }
  if (
    String(admission.patient_uid).toLowerCase()
      !== String(admission.visit_patient_uid).toLowerCase()
  ) {
    throw AppError.conflict(
      'The ICU admission no longer matches its emergency visit patient',
      'CLINICAL_ALERT_RECOVERY_SOURCE_IDENTITY_MISMATCH',
    );
  }
  assertObligationSourceIdentity(row, admission);
  const intent = {
    type: 'push',
    channel: 'push',
    title: 'ICU MAR carryover could not inspect ER medication orders',
    body: 'Review the patient\'s active ER medication orders and repair any missing MAR schedule from the governed order screen.',
    source_event_key: sourceEventKey,
    template_version: 'clinical-alert-icu-mar-carryover-failure.v1',
    data: {
      source_event_key: sourceEventKey,
      icu_admission_id: Number(admission.id),
      emergency_visit_id: Number(admission.emergency_visit_id),
      patient_uid: admission.patient_uid,
      encounter_id: admission.encounter_id,
      error_code: row.failure_code,
      deep_link: `/emr/orders/${admission.patient_uid}?icu_mar_review=${admission.id}`,
      requires_doctor_authority: true,
      supersedes_obligation_id: String(row.obligation_id),
    },
  };
  return {
    sourceTable: source.sourceTable,
    sourceId: source.sourceId,
    failureKind: source.failureKind,
    patientUid: admission.patient_uid,
    encounterId: admission.encounter_id || null,
    originActorUid: admission.origin_actor_uid || null,
    failureCode: row.failure_code,
    notificationIntent: intent,
    supersedesObligationId: String(row.obligation_id),
  };
}

async function ensureRecoveryCaseTx(tx, row, kind) {
  const cleanKind = recoveryCaseKind(kind);
  await tx.$queryRawUnsafe(
    `SELECT 1::int AS locked
       FROM pg_advisory_xact_lock(
         hashtextextended($1::text || ':' || $2::text || ':' || $3::text, 0)
       )`,
    row.tenant_id,
    String(row.id),
    cleanKind,
  );
  const existing = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, obligation_id, case_kind, status,
            workflow_sla_instance_id, task_id, observation_count,
            first_observed_at, last_observed_at, due_at
       FROM clinical_alert_delivery_recovery_cases
      WHERE tenant_id = $1::uuid
        AND obligation_id = $2::bigint
        AND case_kind = $3::text
      LIMIT 1
      FOR UPDATE`,
    row.tenant_id,
    row.id,
    cleanKind,
  );
  if (existing[0]) {
    if (existing[0].status === 'open') {
      const refreshed = await tx.$queryRawUnsafe(
        `UPDATE clinical_alert_delivery_recovery_cases
            SET observation_count = observation_count + 1,
                last_observed_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND status = 'open'
          RETURNING id, tenant_id, obligation_id, case_kind, status,
                    workflow_sla_instance_id, task_id, observation_count,
                    first_observed_at, last_observed_at, due_at`,
        row.tenant_id,
        existing[0].id,
      );
      return refreshed[0] || existing[0];
    }
    return existing[0];
  }

  const rule = CLINICAL_ALERT_RECOVERY_RULES[cleanKind];
  const caseIds = await tx.$queryRawUnsafe(
    `SELECT nextval('clinical_alert_delivery_recovery_cases_id_seq')::bigint AS id`,
  );
  const caseId = String(caseIds[0]?.id || '');
  if (!POSITIVE_INT_RE.test(caseId)) {
    throw AppError.internal(
      'Clinical alert recovery case identity could not be allocated',
      'CLINICAL_ALERT_RECOVERY_CASE_ID_MISSING',
    );
  }
  const slaRows = await tx.$queryRawUnsafe(
    `INSERT INTO workflow_sla_instances
       (tenant_id, rule_id, rule_code, patient_uid, encounter_id,
        source_table, source_id, status, priority, started_at, due_at,
        assigned_role_codes, metadata)
     SELECT $1::uuid, policy.id, $2::text, $3::uuid, $4::uuid,
            $5::text, $6::text, 'active', 'critical',
            date_trunc('milliseconds', NOW()),
            date_trunc('milliseconds', NOW() + make_interval(mins => $7::int)),
            ARRAY['ADMIN']::text[],
            jsonb_build_object(
              'task_contract', $8::text,
              'case_kind', $9::text,
              'obligation_id', $10::text
            )
       FROM workflow_sla_rules policy
      WHERE policy.rule_code = $2::text
        AND policy.enabled = TRUE
        AND (policy.tenant_id = $1::uuid OR policy.tenant_id IS NULL)
      ORDER BY (policy.tenant_id = $1::uuid) DESC
      LIMIT 1
     RETURNING id, due_at`,
    row.tenant_id,
    rule.ruleCode,
    row.patient_uid || null,
    row.encounter_id || null,
    RECOVERY_CASE_SOURCE_TABLE,
    caseId,
    rule.targetMinutes,
    CLINICAL_ALERT_RECOVERY_TASK_CONTRACT,
    cleanKind,
    String(row.id),
  );
  const sla = slaRows[0];
  if (!sla) {
    throw AppError.internal(
      'Clinical alert recovery SLA policy is unavailable',
      'CLINICAL_ALERT_RECOVERY_SLA_POLICY_MISSING',
    );
  }
  const taskRows = await tx.$queryRawUnsafe(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, description, patient_uid,
        related_resource_type, related_resource_id, priority, status,
        assigned_to_role, due_at, workflow_sla_instance_id,
        sla_completion_semantics, stage_occurrence_key, metadata)
     VALUES ($1::uuid, 'escalation', $2::text, $3::text, $4::uuid,
             $5::text, $6::text, 'critical', 'open', 'ADMIN', $7::timestamptz,
             $8::uuid, 'domain_evidence', $9::text,
             jsonb_build_object(
               'task_contract', $10::text,
               'case_kind', $11::text,
               'obligation_id', $12::text,
               'assignment_origin', 'admin_coverage_queue',
               'canonical_encounter_id', $13::text,
               'action_path', '/api/v1/admin/clinical-alert-delivery/recovery-cases/' || $6::text,
               'route', '/clinical-inbox/recovery?case_id=' || $6::text,
               'deep_link', '/clinical-inbox/recovery?case_id=' || $6::text,
               'action_label_key', 'clinical_inbox.open_workflow'
             ))
     RETURNING id`,
    row.tenant_id,
    rule.title,
    cleanKind === 'manual_hold'
      ? 'Review the immutable held alert evidence and supersede it only from its current clinical source.'
      : 'Restore an active duty-doctor or doctor-tier recipient, then run the governed delivery retry.',
    row.patient_uid || null,
    RECOVERY_CASE_SOURCE_TABLE,
    caseId,
    sla.due_at,
    sla.id,
    `clinical-alert-delivery-recovery:${caseId}`,
    CLINICAL_ALERT_RECOVERY_TASK_CONTRACT,
    cleanKind,
    String(row.id),
    row.encounter_id == null ? null : String(row.encounter_id),
  );
  const task = taskRows[0];
  if (!task) {
    throw AppError.internal(
      'Clinical alert recovery task was not persisted',
      'CLINICAL_ALERT_RECOVERY_TASK_MISSING',
    );
  }
  const cases = await tx.$queryRawUnsafe(
    `INSERT INTO clinical_alert_delivery_recovery_cases
       (id, tenant_id, obligation_id, case_kind, status,
        workflow_sla_instance_id, task_id, due_at)
     VALUES ($1::bigint, $2::uuid, $3::bigint, $4::text, 'open',
             $5::uuid, $6::int, $7::timestamptz)
     RETURNING id, tenant_id, obligation_id, case_kind, status,
               workflow_sla_instance_id, task_id, observation_count,
               first_observed_at, last_observed_at, due_at`,
    caseId,
    row.tenant_id,
    row.id,
    cleanKind,
    sla.id,
    task.id,
    sla.due_at,
  );
  return cases[0];
}

async function findRecoveryActionByKeyTx(tx, tenantId, idempotencyKey) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, case_id, action_type, command_sha256, outcome,
            response_payload, created_at
       FROM clinical_alert_delivery_recovery_actions
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1`,
    tenantId,
    idempotencyKey,
  );
  return rows[0] || null;
}

function replayRecoveryAction(action, { caseId, actionType, commandHash }) {
  if (!action) return null;
  if (
    String(action.case_id) !== String(caseId)
    || action.action_type !== actionType
    || action.command_sha256 !== commandHash
  ) {
    throw AppError.conflict(
      'Idempotency-Key was already used for a different clinical alert recovery command',
      'CLINICAL_ALERT_RECOVERY_IDEMPOTENCY_MISMATCH',
    );
  }
  return Object.freeze({
    ...(action.response_payload || {}),
    action_id: apiId(action.id),
    replayed: true,
  });
}

async function recordRecoveryActionTx(tx, {
  tenantId,
  caseId,
  actionType,
  actorUid = null,
  reason,
  idempotencyKey,
  commandHash,
  requestId = null,
  outcome,
  response,
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO clinical_alert_delivery_recovery_actions
       (tenant_id, case_id, action_type, actor_uid, operator_reason,
        idempotency_key, command_sha256, request_id, outcome, response_payload)
     VALUES ($1::uuid, $2::bigint, $3::text, $4::uuid, $5::text,
             $6::text, $7::char(64), $8::text, $9::text, $10::jsonb)
     RETURNING id`,
    tenantId,
    caseId,
    recoveryActionType(actionType),
    actorUid,
    reason,
    idempotencyKey,
    commandHash,
    requestId == null ? null : String(requestId).slice(0, 120),
    outcome,
    JSON.stringify(response),
  );
  if (!rows[0]) {
    throw AppError.internal(
      'Clinical alert recovery action receipt was not persisted',
      'CLINICAL_ALERT_RECOVERY_ACTION_MISSING',
    );
  }
  return rows[0];
}

async function resolveRecoveryCaseTx(tx, {
  recoveryCase,
  actionId,
  actorUid = null,
  reason,
  resolutionKind,
  replacementObligationId = null,
  evidence = {},
}) {
  const resolvedAt = new Date().toISOString();
  const completionEvidence = {
    kind: 'clinical_alert_delivery_recovery_action',
    resource_type: 'clinical_alert_delivery_recovery_actions',
    resource_id: String(actionId),
    case_id: String(recoveryCase.id),
    obligation_id: String(recoveryCase.obligation_id),
    resolution_kind: resolutionKind,
    occurred_at: resolvedAt,
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE clinical_alert_delivery_recovery_cases
        SET status = 'resolved',
            resolution_kind = $3::text,
            resolution_action_id = $4::bigint,
            replacement_obligation_id = $5::bigint,
            resolved_by_uid = $6::uuid,
            resolution_reason = $7::text,
            resolution_evidence = $8::jsonb,
            resolved_at = $9::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'open'
      RETURNING id`,
    recoveryCase.tenant_id,
    recoveryCase.id,
    resolutionKind,
    actionId,
    replacementObligationId,
    actorUid,
    reason,
    JSON.stringify(evidence),
    resolvedAt,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Clinical alert recovery case changed before resolution completed',
      'CLINICAL_ALERT_RECOVERY_CASE_CONFLICT',
    );
  }
  await tx.$executeRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = CASE WHEN status = 'active' THEN 'completed' ELSE status END,
            completed_at = $3::timestamptz,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'completed_via', 'domain_evidence',
                   'completed_by_task', $6::text,
                   'completed_by', $7::text,
                   'completion_evidence', $8::jsonb,
                   'resolution_action_id', $4::text,
                   'resolution_kind', $5::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND completed_at IS NULL`,
    recoveryCase.tenant_id,
    recoveryCase.workflow_sla_instance_id,
    resolvedAt,
    String(actionId),
    resolutionKind,
    String(recoveryCase.task_id),
    actorUid,
    JSON.stringify(completionEvidence),
  );
  await tx.$executeRawUnsafe(
    `UPDATE tasks
        SET status = 'completed',
            completed_at = $3::timestamptz,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'domain_evidence_kind', 'clinical_alert_delivery_recovery_action',
                   'domain_evidence_id', $4::text,
                   'resolution_kind', $5::text,
                   'completion_evidence', $6::jsonb,
                   'resolved_at', $3::timestamptz
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status IN ('open', 'in_progress', 'blocked', 'overdue')`,
    recoveryCase.tenant_id,
    recoveryCase.task_id,
    resolvedAt,
    String(actionId),
    resolutionKind,
    JSON.stringify(completionEvidence),
  );
  return resolvedAt;
}

async function resolveCoverageCaseFromSystemTx(tx, row, outcome) {
  const cases = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, obligation_id, case_kind, status,
            workflow_sla_instance_id, task_id
       FROM clinical_alert_delivery_recovery_cases
      WHERE tenant_id = $1::uuid
        AND obligation_id = $2::bigint
        AND case_kind = 'recipient_coverage'
        AND status = 'open'
      LIMIT 1
      FOR UPDATE`,
    row.tenant_id,
    row.id,
  );
  const recoveryCase = cases[0];
  if (!recoveryCase) return null;
  const actionType = outcome === 'recovered'
    ? 'system_delivery_recovered'
    : 'system_manual_hold';
  const reason = outcome === 'recovered'
    ? 'The governed recovery sweep resolved a concrete clinical recipient.'
    : 'The governed recovery sweep moved the obligation to manual hold.';
  const idempotencyKey = `system:${actionType}:${row.id}`;
  const commandHash = commandSha256({
    case_id: String(recoveryCase.id),
    action_type: actionType,
    obligation_id: String(row.id),
  });
  const response = {
    case_id: apiId(recoveryCase.id),
    obligation_id: apiId(row.id),
    outcome,
  };
  const action = await recordRecoveryActionTx(tx, {
    tenantId: row.tenant_id,
    caseId: recoveryCase.id,
    actionType,
    reason,
    idempotencyKey,
    commandHash,
    outcome,
    response,
  });
  await resolveRecoveryCaseTx(tx, {
    recoveryCase,
    actionId: action.id,
    reason,
    resolutionKind: outcome,
    evidence: response,
  });
  return action;
}

async function putOnManualHold(tx, row, code) {
  const reason = HOLD_REASONS[code];
  const rows = await tx.$queryRawUnsafe(
    `UPDATE clinical_alert_delivery_obligations
        SET status = 'manual_hold',
            attempt_count = attempt_count + 1,
            last_attempted_at = NOW(),
            next_attempt_at = NOW(),
            last_error_code = $3::text,
            manual_hold_code = $3::text,
            manual_hold_reason = $4::text,
            held_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'pending'
      RETURNING id`,
    row.tenant_id,
    row.id,
    code,
    reason,
  );
  if (!rows[0]) return null;
  await ensureRecoveryCaseTx(tx, row, 'manual_hold');
  return apiId(rows[0].id);
}

async function markPendingAttempt({ tenantId, id, errorCode }) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE clinical_alert_delivery_obligations
          SET attempt_count = attempt_count + 1,
              last_attempted_at = NOW(),
              next_attempt_at = NOW() + make_interval(mins => $4::int),
              last_error_code = $3::text
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'pending'
        RETURNING id`,
      tenantId,
      id,
      errorCode,
      RETRY_DELAY_MINUTES,
    );
    return rows[0] || null;
  });
}

async function recoverOne(tx, row, {
  actorUid,
  outbox,
  resolveRecipients,
  reconcileCase = true,
}) {
  let intent;
  let policy;
  try {
    intent = storedIntent(row);
    policy = storedPolicy(row);
    await assertSourceMatches(tx, row, intent);
  } catch (error) {
    const code = holdCode(error);
    if (!code) throw error;
    const id = await putOnManualHold(tx, row, code);
    if (reconcileCase) {
      await resolveCoverageCaseFromSystemTx(tx, row, 'manual_hold');
    }
    return { kind: 'held', id };
  }

  const recipients = await resolveRecipients(row.tenant_id, {
    tx,
    primaryRole: policy.primary_role,
    fallbackRoles: policy.fallback_roles,
  });
  if (recipients.length === 0) {
    await tx.$executeRawUnsafe(
      `UPDATE clinical_alert_delivery_obligations
          SET attempt_count = attempt_count + 1,
              last_attempted_at = NOW(),
              next_attempt_at = NOW() + make_interval(mins => $3::int),
              last_error_code = 'no_active_clinical_recipients'
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'pending'`,
      row.tenant_id,
      row.id,
      RETRY_DELAY_MINUTES,
    );
    const recoveryCase = await ensureRecoveryCaseTx(tx, row, 'recipient_coverage');
    return { kind: 'awaiting_recipients', recoveryCase };
  }

  const queued = [];
  for (const recipient of recipients) {
    const outboxRow = await outbox.queue({
      tenantId: row.tenant_id,
      type: intent.type,
      channel: intent.channel,
      recipientId: recipient.uid,
      recipientPhone: recipient.phone || null,
      title: intent.title,
      body: intent.body,
      sourceEventKey: intent.source_event_key,
      templateVersion: intent.template_version,
      data: {
        ...intent.data,
        recipient_role: recipient.role || null,
      },
    }, { tx, strict: true });
    if (!outboxRow?.id) {
      throw AppError.internal(
        'Clinical alert recovery outbox evidence was not persisted',
        'CLINICAL_ALERT_OBLIGATION_OUTBOX_MISSING',
      );
    }
    queued.push({ id: Number(outboxRow.id), recipientId: String(recipient.uid) });
  }

  const recoveredAt = new Date().toISOString();
  const outboxIds = queued.map((item) => item.id);
  const recipientIds = queued.map((item) => item.recipientId);
  const evidence = {
    recovery_source: CLINICAL_ALERT_RECOVERY_SOURCE,
    notification_outbox_ids: outboxIds,
    recipient_ids: recipientIds,
    recovered_at: recoveredAt,
    ...(actorUid ? { recovery_actor_uid: actorUid } : {}),
  };
  const completed = await tx.$queryRawUnsafe(
    `UPDATE clinical_alert_delivery_obligations
        SET status = 'completed',
            attempt_count = attempt_count + 1,
            last_attempted_at = NOW(),
            next_attempt_at = NOW(),
            last_error_code = NULL,
            completion_notification_outbox_id = $3::int,
            completion_notification_outbox_ids = $4::int[],
            completion_recipient_ids = $5::text[],
            completion_evidence = $6::jsonb,
            completed_at = $7::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'pending'
      RETURNING id`,
    row.tenant_id,
    row.id,
    outboxIds[0],
    outboxIds,
    recipientIds,
    JSON.stringify(evidence),
    recoveredAt,
  );
  if (!completed[0]) return { kind: 'skipped' };
  if (reconcileCase) {
    await resolveCoverageCaseFromSystemTx(tx, row, 'recovered');
  }
  return { kind: 'recovered', id: apiId(completed[0].id) };
}

export async function sweepClinicalAlertDeliveryObligations({
  tenantId,
  actorUid = null,
  limit = DEFAULT_LIMIT,
  deps = {},
} = {}) {
  const tid = requiredTenantId(tenantId);
  const cleanActorUid = optionalUuid(actorUid, 'recovery actor identity');
  const safeLimit = boundedLimit(limit);
  const candidateIds = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id
       FROM clinical_alert_delivery_obligations
      WHERE tenant_id = $1::uuid
        AND status = 'pending'
        AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT $2::int`,
    tid,
    safeLimit,
  ));

  const result = {
    scanned: candidateIds.length,
    recovered: 0,
    held: 0,
    awaitingRecipients: 0,
    failed: 0,
    recoveredIds: [],
    heldIds: [],
    limit: safeLimit,
  };
  const outbox = deps.notificationOutbox || notificationOutbox;
  const resolveRecipients = deps.resolveClinicalAlertRecipients
    || resolveClinicalAlertRecipients;

  for (const candidate of candidateIds) {
    try {
      const outcome = await setTenantTx(tid, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT id, tenant_id, obligation_key, source_table, source_id,
                  source_event_key, failure_kind, patient_uid, encounter_id,
                  origin_actor_uid, failure_code, recipient_policy,
                  notification_intent, supersedes_obligation_id, status,
                  attempt_count, last_attempted_at, next_attempt_at,
                  last_error_code
             FROM clinical_alert_delivery_obligations
            WHERE tenant_id = $1::uuid
              AND id = $2::bigint
              AND status = 'pending'
              AND next_attempt_at <= NOW()
            FOR UPDATE SKIP LOCKED`,
          tid,
          candidate.id,
        );
        if (!rows[0]) return { kind: 'skipped' };
        return recoverOne(tx, rows[0], {
          actorUid: cleanActorUid,
          outbox,
          resolveRecipients,
        });
      });
      if (outcome.kind === 'recovered') {
        result.recovered += 1;
        result.recoveredIds.push(outcome.id);
      } else if (outcome.kind === 'held') {
        result.held += 1;
        if (outcome.id != null) result.heldIds.push(outcome.id);
      } else if (outcome.kind === 'awaiting_recipients') {
        result.awaitingRecipients += 1;
      }
    } catch (error) {
      result.failed += 1;
      logger.error('Clinical alert delivery obligation recovery failed', {
        tenant_id: tid,
        obligation_id: Number(candidate.id),
        error_code: error?.code || null,
        err: error?.message,
      });
      await markPendingAttempt({
        tenantId: tid,
        id: candidate.id,
        errorCode: 'clinical_alert_recovery_queue_failed',
      }).catch((recordError) => {
        logger.error('Clinical alert recovery attempt evidence could not be recorded', {
          tenant_id: tid,
          obligation_id: Number(candidate.id),
          error_code: recordError?.code || null,
        });
      });
    }
  }
  result.recoveryEscalation = await escalateClinicalAlertRecoveryCases({
    tenantId: tid,
    limit: safeLimit,
    deps,
  });
  return result;
}

async function getRecoveryCaseForUpdateTx(tx, tenantId, caseId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT recovery.id, recovery.tenant_id, recovery.obligation_id,
            recovery.case_kind, recovery.status,
            recovery.workflow_sla_instance_id, recovery.task_id,
            recovery.due_at, recovery.resolution_action_id,
            obligation.source_table, obligation.source_id,
            obligation.source_event_key, obligation.failure_kind,
            obligation.patient_uid::text, obligation.encounter_id::text,
            obligation.origin_actor_uid::text, obligation.failure_code,
            obligation.recipient_policy, obligation.notification_intent,
            obligation.status AS obligation_status,
            obligation.supersedes_obligation_id,
            obligation.next_attempt_at
       FROM clinical_alert_delivery_recovery_cases recovery
       JOIN clinical_alert_delivery_obligations obligation
         ON obligation.tenant_id = recovery.tenant_id
        AND obligation.id = recovery.obligation_id
      WHERE recovery.tenant_id = $1::uuid
        AND recovery.id = $2::bigint
      LIMIT 1
      FOR UPDATE OF recovery, obligation`,
    tenantId,
    caseId,
  );
  if (!rows[0]) {
    throw AppError.notFound(
      'Clinical alert recovery case not found',
      'CLINICAL_ALERT_RECOVERY_CASE_NOT_FOUND',
    );
  }
  return rows[0];
}

function requireOpenCase(recoveryCase, expectedKind) {
  if (recoveryCase.status !== 'open') {
    throw AppError.conflict(
      'Clinical alert recovery case is already resolved',
      'CLINICAL_ALERT_RECOVERY_CASE_RESOLVED',
    );
  }
  if (recoveryCase.case_kind !== expectedKind) {
    throw AppError.conflict(
      `Clinical alert recovery action requires a ${expectedKind} case`,
      'CLINICAL_ALERT_RECOVERY_CASE_KIND_MISMATCH',
    );
  }
}

export async function retryClinicalAlertRecoveryCase({
  tenantId,
  caseId,
  actorUid,
  reason,
  idempotencyKey,
  requestId = null,
  deps = {},
} = {}) {
  const tid = requiredTenantId(tenantId);
  const cleanCaseId = positiveId(caseId, 'caseId');
  const cleanActorUid = optionalUuid(actorUid, 'recovery actor identity');
  if (!cleanActorUid) {
    throw AppError.forbidden(
      'Clinical alert recovery requires an authenticated administrator',
      'CLINICAL_ALERT_RECOVERY_ACTOR_REQUIRED',
    );
  }
  const cleanReason = recoveryReason(reason);
  const key = recoveryIdempotencyKey(idempotencyKey);
  const actionType = 'retry_delivery';
  const commandHash = commandSha256({
    case_id: cleanCaseId,
    action_type: actionType,
    reason: cleanReason,
  });

  return setTenantTx(tid, async (tx) => {
    const prior = replayRecoveryAction(
      await findRecoveryActionByKeyTx(tx, tid, key),
      { caseId: cleanCaseId, actionType, commandHash },
    );
    if (prior) return prior;
    const recoveryCase = await getRecoveryCaseForUpdateTx(tx, tid, cleanCaseId);
    const lockedReplay = replayRecoveryAction(
      await findRecoveryActionByKeyTx(tx, tid, key),
      { caseId: cleanCaseId, actionType, commandHash },
    );
    if (lockedReplay) return lockedReplay;
    requireOpenCase(recoveryCase, 'recipient_coverage');
    if (recoveryCase.obligation_status !== 'pending') {
      throw AppError.conflict(
        'Recipient coverage retry requires a pending delivery obligation',
        'CLINICAL_ALERT_RECOVERY_OBLIGATION_NOT_PENDING',
      );
    }
    const outcome = await recoverOne(tx, {
      ...recoveryCase,
      id: recoveryCase.obligation_id,
    }, {
      actorUid: cleanActorUid,
      outbox: deps.notificationOutbox || notificationOutbox,
      resolveRecipients: deps.resolveClinicalAlertRecipients
        || resolveClinicalAlertRecipients,
      reconcileCase: false,
    });
    if (!['recovered', 'awaiting_recipients', 'held'].includes(outcome.kind)) {
      throw AppError.conflict(
        'Clinical alert recovery obligation changed before retry completed',
        'CLINICAL_ALERT_RECOVERY_OBLIGATION_CONFLICT',
      );
    }
    const response = {
      case_id: apiId(recoveryCase.id),
      obligation_id: apiId(recoveryCase.obligation_id),
      outcome: outcome.kind,
      ...(outcome.kind === 'held' ? { manual_hold_case_created: true } : {}),
    };
    const actionOutcome = outcome.kind === 'held' ? 'manual_hold' : outcome.kind;
    const action = await recordRecoveryActionTx(tx, {
      tenantId: tid,
      caseId: recoveryCase.id,
      actionType,
      actorUid: cleanActorUid,
      reason: cleanReason,
      idempotencyKey: key,
      commandHash,
      requestId,
      outcome: actionOutcome,
      response,
    });
    if (outcome.kind === 'recovered' || outcome.kind === 'held') {
      await resolveRecoveryCaseTx(tx, {
        recoveryCase,
        actionId: action.id,
        actorUid: cleanActorUid,
        reason: cleanReason,
        resolutionKind: outcome.kind === 'recovered' ? 'recovered' : 'manual_hold',
        evidence: response,
      });
    }
    return Object.freeze({
      ...response,
      action_id: apiId(action.id),
      replayed: false,
    });
  });
}

export async function supersedeClinicalAlertRecoveryCase({
  tenantId,
  caseId,
  actorUid,
  reason,
  idempotencyKey,
  requestId = null,
} = {}) {
  const tid = requiredTenantId(tenantId);
  const cleanCaseId = positiveId(caseId, 'caseId');
  const cleanActorUid = optionalUuid(actorUid, 'recovery actor identity');
  if (!cleanActorUid) {
    throw AppError.forbidden(
      'Clinical alert recovery requires an authenticated administrator',
      'CLINICAL_ALERT_RECOVERY_ACTOR_REQUIRED',
    );
  }
  const cleanReason = recoveryReason(reason);
  const key = recoveryIdempotencyKey(idempotencyKey);
  const actionType = 'supersede_from_source';
  const commandHash = commandSha256({
    case_id: cleanCaseId,
    action_type: actionType,
    reason: cleanReason,
  });

  return setTenantTx(tid, async (tx) => {
    const prior = replayRecoveryAction(
      await findRecoveryActionByKeyTx(tx, tid, key),
      { caseId: cleanCaseId, actionType, commandHash },
    );
    if (prior) return prior;
    const recoveryCase = await getRecoveryCaseForUpdateTx(tx, tid, cleanCaseId);
    const lockedReplay = replayRecoveryAction(
      await findRecoveryActionByKeyTx(tx, tid, key),
      { caseId: cleanCaseId, actionType, commandHash },
    );
    if (lockedReplay) return lockedReplay;
    requireOpenCase(recoveryCase, 'manual_hold');
    if (recoveryCase.obligation_status !== 'manual_hold') {
      throw AppError.conflict(
        'Supersession requires an immutable manual-hold obligation',
        'CLINICAL_ALERT_RECOVERY_OBLIGATION_NOT_HELD',
      );
    }
    const replacementInput = await deriveSupersedingObligationTx(tx, recoveryCase);
    const replacement = await createClinicalAlertDeliveryObligationTx(tx, {
      tenantId: tid,
      ...replacementInput,
    });
    const response = {
      case_id: apiId(recoveryCase.id),
      obligation_id: apiId(recoveryCase.obligation_id),
      replacement_obligation_id: apiId(replacement.id),
      replacement_status: replacement.status,
      outcome: 'superseded',
    };
    const action = await recordRecoveryActionTx(tx, {
      tenantId: tid,
      caseId: recoveryCase.id,
      actionType,
      actorUid: cleanActorUid,
      reason: cleanReason,
      idempotencyKey: key,
      commandHash,
      requestId,
      outcome: 'superseded',
      response,
    });
    await resolveRecoveryCaseTx(tx, {
      recoveryCase,
      actionId: action.id,
      actorUid: cleanActorUid,
      reason: cleanReason,
      resolutionKind: 'superseded',
      replacementObligationId: replacement.id,
      evidence: response,
    });
    return Object.freeze({
      ...response,
      action_id: apiId(action.id),
      replayed: false,
    });
  });
}

export async function listClinicalAlertRecoveryCases({
  tenantId,
  status = 'open',
  caseKind = null,
  caseId = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requiredTenantId(tenantId);
  const cleanStatus = recoveryCaseStatus(status);
  const cleanKind = caseKind == null || caseKind === ''
    ? null
    : recoveryCaseKind(caseKind);
  const cleanCaseId = caseId == null || caseId === ''
    ? null
    : positiveId(caseId, 'Recovery case id');
  const safeLimit = boundedLimit(limit);
  const cases = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT recovery.id AS case_id,
            recovery.case_kind, recovery.status AS case_status,
            recovery.obligation_id, recovery.first_observed_at,
            recovery.last_observed_at, recovery.observation_count,
            recovery.due_at,
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - recovery.first_observed_at)))::bigint
              AS open_age_seconds,
            (recovery.status = 'open' AND recovery.due_at <= NOW()) AS overdue,
            recovery.escalation_attempt_count,
            recovery.last_escalation_attempt_at,
            recovery.last_escalation_error_code,
            recovery.escalated_at,
            recovery.resolution_kind, recovery.resolution_action_id,
            recovery.replacement_obligation_id, recovery.resolved_by_uid::text,
            recovery.resolution_reason, recovery.resolved_at,
            obligation.source_table, obligation.source_id,
            obligation.source_event_key, obligation.failure_kind,
            obligation.patient_uid::text, obligation.encounter_id::text,
            obligation.status AS obligation_status,
            obligation.attempt_count AS obligation_attempt_count,
            obligation.last_attempted_at, obligation.next_attempt_at,
            obligation.last_error_code, obligation.manual_hold_code,
            obligation.manual_hold_reason, obligation.held_at,
            sla.id AS workflow_sla_instance_id, sla.rule_code AS sla_rule_code,
            sla.status AS sla_status, sla.breached_at AS sla_breached_at,
            sla.escalated_at AS sla_escalated_at, sla.completed_at AS sla_completed_at,
            task.id AS task_id, task.status AS task_status,
            task.assigned_to_uid::text, task.assigned_to_role,
            replacement.status AS replacement_obligation_status
       FROM clinical_alert_delivery_recovery_cases recovery
       JOIN clinical_alert_delivery_obligations obligation
         ON obligation.tenant_id = recovery.tenant_id
        AND obligation.id = recovery.obligation_id
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = recovery.tenant_id
        AND sla.id = recovery.workflow_sla_instance_id
       JOIN tasks task
         ON task.tenant_id = recovery.tenant_id
        AND task.id = recovery.task_id
       LEFT JOIN clinical_alert_delivery_obligations replacement
         ON replacement.tenant_id = recovery.tenant_id
        AND replacement.id = recovery.replacement_obligation_id
      WHERE recovery.tenant_id = $1::uuid
        AND ($2::text IS NULL OR recovery.status = $2::text)
        AND ($3::text IS NULL OR recovery.case_kind = $3::text)
        AND ($4::bigint IS NULL OR recovery.id = $4::bigint)
      ORDER BY
        CASE WHEN recovery.status = 'open' AND recovery.due_at <= NOW() THEN 0 ELSE 1 END,
        recovery.due_at ASC, recovery.id ASC
      LIMIT $5::int`,
    tid,
    cleanStatus,
    cleanKind,
    cleanCaseId,
    safeLimit,
  ));
  return Object.freeze({
    cases: cases.map(jsonSafe),
    count: cases.length,
    limit: safeLimit,
  });
}

export async function getClinicalAlertRecoveryCase({ tenantId, caseId } = {}) {
  const result = await listClinicalAlertRecoveryCases({
    tenantId,
    caseId,
    status: null,
    limit: 1,
  });
  if (!result.cases[0]) {
    throw AppError.notFound(
      'Clinical alert recovery case not found',
      'CLINICAL_ALERT_RECOVERY_CASE_NOT_FOUND',
    );
  }
  return result.cases[0];
}

export async function escalateClinicalAlertRecoveryCases({
  tenantId,
  limit = DEFAULT_LIMIT,
  deps = {},
} = {}) {
  const tid = requiredTenantId(tenantId);
  const safeLimit = boundedLimit(limit);
  const candidateIds = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id
       FROM clinical_alert_delivery_recovery_cases
      WHERE tenant_id = $1::uuid
        AND status = 'open'
        AND due_at <= NOW()
        AND escalated_at IS NULL
      ORDER BY due_at ASC, id ASC
      LIMIT $2::int`,
    tid,
    safeLimit,
  ));
  const result = { scanned: candidateIds.length, escalated: 0, awaitingAdmin: 0, failed: 0 };
  const outbox = deps.notificationOutbox || notificationOutbox;
  for (const candidate of candidateIds) {
    try {
      const outcome = await setTenantTx(tid, async (tx) => {
        const cases = await tx.$queryRawUnsafe(
          `SELECT recovery.id, recovery.tenant_id, recovery.case_kind,
                  recovery.obligation_id, recovery.task_id,
                  recovery.workflow_sla_instance_id, recovery.due_at,
                  obligation.patient_uid::text, obligation.source_table,
                  obligation.source_id
             FROM clinical_alert_delivery_recovery_cases recovery
             JOIN clinical_alert_delivery_obligations obligation
               ON obligation.tenant_id = recovery.tenant_id
              AND obligation.id = recovery.obligation_id
            WHERE recovery.tenant_id = $1::uuid
              AND recovery.id = $2::bigint
              AND recovery.status = 'open'
              AND recovery.due_at <= NOW()
              AND recovery.escalated_at IS NULL
            FOR UPDATE OF recovery`,
          tid,
          candidate.id,
        );
        const recoveryCase = cases[0];
        if (!recoveryCase) return 'skipped';
        const recipients = await tx.$queryRawUnsafe(
          `SELECT id, uid::text, phone, role, preferred_language
             FROM users
            WHERE tenant_id = $1::uuid
              AND role = ANY(ARRAY['ADMIN', 'SUPER_ADMIN']::text[])
              AND is_active = TRUE
              AND COALESCE(is_deleted, FALSE) = FALSE
              AND deleted_at IS NULL
              AND LOWER(COALESCE(status, 'active')) = 'active'
            ORDER BY last_sign_in_at DESC NULLS LAST, id ASC
            LIMIT 25`,
          tid,
        );
        let queued = 0;
        const queuedIds = [];
        let errorCode = null;
        if (recipients.length === 0) {
          errorCode = 'no_active_admin_recipients';
        } else {
          await tx.$executeRawUnsafe('SAVEPOINT clinical_alert_recovery_escalation');
          try {
            for (const recipient of recipients) {
              const presentation = recoveryEscalationPresentation(
                recipient.preferred_language,
                recoveryCase.case_kind,
              );
              const queuedRow = await outbox.queue({
                tenantId: tid,
                type: 'clinical_alert_delivery_recovery_overdue',
                channel: 'push',
                recipientId: recipient.uid,
                recipientPhone: recipient.phone || null,
                title: presentation.title,
                body: presentation.body,
                sourceEventKey: `clinical-alert-recovery-case:${recoveryCase.id}:overdue:${recipient.uid}`,
                templateVersion: 'clinical-alert-delivery-recovery-escalation.v1',
                data: {
                  kind: 'clinical_alert_delivery_recovery_overdue',
                  recovery_case_id: apiId(recoveryCase.id),
                  obligation_id: apiId(recoveryCase.obligation_id),
                  case_kind: recoveryCase.case_kind,
                  patient_uid: recoveryCase.patient_uid,
                  action_path: `/api/v1/admin/clinical-alert-delivery/recovery-cases/${recoveryCase.id}`,
                  route: `/clinical-inbox/recovery?case_id=${recoveryCase.id}`,
                  deep_link: `/clinical-inbox/recovery?case_id=${recoveryCase.id}`,
                  action_label_key: 'clinical_inbox.open_workflow',
                  recipient_role: recipient.role,
                  presentation_key: 'clinical_alert_delivery_recovery_overdue',
                  presentation_locale: presentation.locale,
                  presentation_copy_version:
                    'clinical-alert-delivery-recovery-escalation.v1',
                  presentations: CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS,
                },
              }, { tx, strict: true });
              if (!queuedRow?.id) {
                throw AppError.internal(
                  'Clinical alert recovery escalation outbox evidence is missing',
                  'CLINICAL_ALERT_RECOVERY_ESCALATION_OUTBOX_MISSING',
                );
              }
              queuedIds.push(String(queuedRow.id));
              queued += 1;
            }
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT clinical_alert_recovery_escalation');
          } catch (error) {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT clinical_alert_recovery_escalation');
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT clinical_alert_recovery_escalation');
            errorCode = error?.code || 'escalation_enqueue_failed';
            queued = 0;
            queuedIds.length = 0;
          }
        }
        // Outbox evidence is timestamp(3), so PostgreSQL may round its NOW()
        // upward. Use the next millisecond for every receipt-bound timestamp;
        // transaction-stable NOW() keeps the case, SLA, and task identical.
        await tx.$executeRawUnsafe(
          `UPDATE clinical_alert_delivery_recovery_cases
              SET escalation_attempt_count = escalation_attempt_count + 1,
                  last_escalation_attempt_at =
                    date_trunc('milliseconds', NOW()) + INTERVAL '1 millisecond',
                  last_escalation_error_code = $3::text,
                  escalated_at = CASE WHEN $4::int > 0
                    THEN date_trunc('milliseconds', NOW()) + INTERVAL '1 millisecond'
                    ELSE NULL
                  END
            WHERE tenant_id = $1::uuid
              AND id = $2::bigint`,
          tid,
          recoveryCase.id,
          errorCode,
          queued,
        );
        await tx.$executeRawUnsafe(
          `UPDATE workflow_sla_instances
              SET status = CASE WHEN $3::int > 0 THEN 'escalated' ELSE 'breached' END,
                  breached_at = COALESCE(breached_at, due_at),
                  escalated_at = CASE WHEN $3::int > 0
                    THEN date_trunc('milliseconds', NOW()) + INTERVAL '1 millisecond'
                    ELSE NULL
                  END,
                   metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object(
                          'recovery_escalation_recipient_count', $3::int,
                          'recovery_escalation_error_code', $4::text
                        )
                     || CASE WHEN $3::int > 0
                          THEN jsonb_build_object(
                            'recovery_escalation_version',
                              'clinical_alert_delivery_recovery_escalation_v1',
                            'recovery_escalation_outbox_ids', $5::jsonb,
                            'recovery_escalated_at',
                              date_trunc('milliseconds', NOW())
                                + INTERVAL '1 millisecond'
                          )
                          ELSE '{}'::jsonb
                        END,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::uuid
              AND completed_at IS NULL`,
          tid,
          recoveryCase.workflow_sla_instance_id,
          queued,
          errorCode,
          JSON.stringify(queuedIds),
        );
        await tx.$executeRawUnsafe(
          `UPDATE tasks
              SET status = CASE WHEN status = 'open' THEN 'overdue' ELSE status END,
                  sla_breached_at = COALESCE(sla_breached_at, due_at),
                   metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object(
                          'recovery_escalation_recipient_count', $3::int,
                          'recovery_escalation_error_code', $4::text,
                          'recovery_escalation_attempted_at',
                            date_trunc('milliseconds', NOW())
                              + INTERVAL '1 millisecond'
                        )
                     || CASE WHEN $3::int > 0
                          THEN jsonb_build_object(
                            'recovery_escalation_version',
                              'clinical_alert_delivery_recovery_escalation_v1',
                            'recovery_escalation_outbox_ids', $5::jsonb,
                            'recovery_escalated_at',
                              date_trunc('milliseconds', NOW())
                                + INTERVAL '1 millisecond'
                          )
                          ELSE '{}'::jsonb
                        END,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::int
              AND status IN ('open', 'in_progress', 'blocked', 'overdue')`,
          tid,
          recoveryCase.task_id,
          queued,
          errorCode,
          JSON.stringify(queuedIds),
        );
        return queued > 0 ? 'escalated' : 'awaiting_admin';
      });
      if (outcome === 'escalated') result.escalated += 1;
      if (outcome === 'awaiting_admin') result.awaitingAdmin += 1;
    } catch (error) {
      result.failed += 1;
      logger.error('Clinical alert recovery case escalation failed', {
        tenant_id: tid,
        recovery_case_id: Number(candidate.id),
        error_code: error?.code || null,
        err: error?.message,
      });
    }
  }
  return result;
}

export default Object.freeze({
  createClinicalAlertDeliveryObligationTx,
  persistClinicalAlertFailureWithCanonical,
  sweepClinicalAlertDeliveryObligations,
  listClinicalAlertRecoveryCases,
  getClinicalAlertRecoveryCase,
  retryClinicalAlertRecoveryCase,
  supersedeClinicalAlertRecoveryCase,
  escalateClinicalAlertRecoveryCases,
});
