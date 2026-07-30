import { AppError } from '../../utils/AppError.js';
import { setTenantTx } from '../../lib/prisma.js';
import {
  CLINICAL_CONTINUITY_ACTION_CATALOG,
  CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES,
  CLINICAL_CONTINUITY_ACTION_REGISTRY_SCHEMA_VERSION,
  CLINICAL_CONTINUITY_ACTIONS_BY_ID
} from '../../config/clinicalContinuityActionCatalog.js';
import {
  canonicalizeJson,
  hashCanonicalValue,
  normalizeGovernanceVersion
} from './continuityPackCanonical.js';
import {
  loadActiveClinicalContinuityPolicyForFacilityTx,
  loadHistoricalClinicalContinuityPolicyForActionTx
} from './clinicalContinuityPolicyService.js';
import { validateClinicalContinuityActionBody } from '../../validators/clinicalContinuityActionSchemas.js';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const APP_POSTURES = new Set(['desktop', 'tablet']);
const ACTIVATION_MODES = new Set(['shadow', 'enforce']);
const COMPATIBILITY_OUTCOMES = new Set(['allow', 'needs_review']);
const AUDIT_DECISIONS = new Set(['deny', 'needs_review', 'would_deny']);
const AUDIT_ROUTE_TEMPLATES = new Set([
  '/api/v1/emr/notes/draft',
  ...CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES.map(alias => alias.routePattern),
  'unmatched'
]);
const AUDIT_OWNERS = new Set([
  'clinical_continuity_governance',
  ...CLINICAL_CONTINUITY_ACTION_CATALOG.flatMap(action => [
    action.conflictOwnership.owner,
    action.quarantineOwnership.owner
  ])
]);

function registryConflict(message, code = 'CONTINUITY_ACTION_REGISTRY_INVALID') {
  throw AppError.conflict(message, code);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) registryConflict(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    registryConflict(`${label} has unknown or missing fields`);
  }
}

function normalizedChecksum(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const normalized = String(value || '').trim().toLowerCase();
  if (!CHECKSUM_PATTERN.test(normalized)) registryConflict(`${label} must be lower-case SHA-256`);
  return normalized;
}

function normalizedTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    registryConflict(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizedSemver(value, label) {
  const normalized = String(value || '').trim();
  if (!SEMVER_PATTERN.test(normalized)) registryConflict(`${label} must be semantic version x.y.z`);
  return normalized;
}

function compareSemver(left, right) {
  const leftParts = left.split('-', 1)[0].split('.').map(Number);
  const rightParts = right.split('-', 1)[0].split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function normalizeActionEntries(value) {
  if (!Array.isArray(value) || value.length !== CLINICAL_CONTINUITY_ACTION_CATALOG.length) {
    registryConflict(
      `actionRegistry.actions must contain exactly ${CLINICAL_CONTINUITY_ACTION_CATALOG.length} approved actions`
    );
  }
  const byId = new Map();
  for (const entry of value) {
    const actionId = String(entry?.actionId || '');
    if (!actionId || byId.has(actionId)) {
      registryConflict(`actionRegistry.actions contains duplicate or missing action ID ${actionId}`);
    }
    byId.set(actionId, entry);
  }
  const normalized = [];
  for (const approved of CLINICAL_CONTINUITY_ACTION_CATALOG) {
    const supplied = byId.get(approved.actionId);
    if (!supplied) registryConflict(`Missing approved action ${approved.actionId}`);
    if (canonicalizeJson(supplied) !== canonicalizeJson(approved)) {
      registryConflict(
        `Action ${approved.actionId} does not match the countersigned C-D3 contract`,
        'CONTINUITY_ACTION_CLASSIFICATION_MISMATCH'
      );
    }
    const withoutChecksum = { ...supplied };
    delete withoutChecksum.actionChecksum;
    if (hashCanonicalValue(withoutChecksum) !== supplied.actionChecksum) {
      registryConflict(
        `Action ${approved.actionId} checksum is invalid`,
        'CONTINUITY_ACTION_CHECKSUM_MISMATCH'
      );
    }
    normalized.push(approved);
  }
  return normalized;
}

function normalizeCompatibilityRule(value, index) {
  const label = `actionRegistry.compatibilityRules[${index}]`;
  exactKeys(
    value,
    [
      'actionChecksum',
      'actionId',
      'actionSchemaChecksum',
      'actionSchemaVersion',
      'actionVersion',
      'fromPolicyChecksum',
      'fromPolicyEffectiveFrom',
      'fromPolicyEffectiveUntil',
      'fromPolicyId',
      'fromPolicySigningKeyId',
      'fromPolicySupersedesId',
      'fromPolicyVersion',
      'fromRevocationEpoch',
      'fromRegistryChecksum',
      'fromRegistryVersion',
      'maximumCaptureAgeMinutes',
      'outcome'
    ],
    label
  );
  const actionId = String(value.actionId || '');
  const action = CLINICAL_CONTINUITY_ACTIONS_BY_ID[actionId];
  if (!action) registryConflict(`${label}.actionId is unknown`);
  if (!UUID_PATTERN.test(String(value.fromPolicyId || '').toLowerCase())) {
    registryConflict(`${label}.fromPolicyId must be a UUID`);
  }
  if (
    value.fromPolicySupersedesId !== null &&
    !UUID_PATTERN.test(String(value.fromPolicySupersedesId || '').toLowerCase())
  ) {
    registryConflict(`${label}.fromPolicySupersedesId must be a UUID or null`);
  }
  if (!KEY_ID_PATTERN.test(String(value.fromPolicySigningKeyId || ''))) {
    registryConflict(`${label}.fromPolicySigningKeyId is invalid`);
  }
  if (!COMPATIBILITY_OUTCOMES.has(value.outcome)) {
    registryConflict(`${label}.outcome is unsupported`);
  }
  const maximumCaptureAgeMinutes = Number(value.maximumCaptureAgeMinutes);
  if (
    !Number.isInteger(maximumCaptureAgeMinutes) ||
    maximumCaptureAgeMinutes <= 0 ||
    maximumCaptureAgeMinutes > 525_600
  ) {
    registryConflict(`${label}.maximumCaptureAgeMinutes is invalid`);
  }
  const actionSchemaChecksum = normalizedChecksum(
    value.actionSchemaChecksum,
    `${label}.actionSchemaChecksum`,
    { nullable: true }
  );
  if (
    value.outcome === 'allow' &&
    (!action.classification.captureReady ||
      action.replayEndpoint.bindingId === 'none' ||
      actionSchemaChecksum === null)
  ) {
    registryConflict(`${label} cannot auto-allow a non-executable action`);
  }
  const fromPolicyEffectiveFrom = normalizedTimestamp(
    value.fromPolicyEffectiveFrom,
    `${label}.fromPolicyEffectiveFrom`
  );
  const fromPolicyEffectiveUntil = normalizedTimestamp(
    value.fromPolicyEffectiveUntil,
    `${label}.fromPolicyEffectiveUntil`
  );
  if (Date.parse(fromPolicyEffectiveUntil) <= Date.parse(fromPolicyEffectiveFrom)) {
    registryConflict(`${label} policy effective window is invalid`);
  }
  const actionSchemaVersion = Number(value.actionSchemaVersion);
  const actionVersion = Number(value.actionVersion);
  if (
    !Number.isInteger(actionSchemaVersion) ||
    actionSchemaVersion < 0 ||
    !Number.isInteger(actionVersion) ||
    actionVersion <= 0
  ) {
    registryConflict(`${label} action version fields are invalid`);
  }
  return {
    actionChecksum: normalizedChecksum(value.actionChecksum, `${label}.actionChecksum`),
    actionId,
    actionSchemaChecksum,
    actionSchemaVersion,
    actionVersion,
    fromPolicyChecksum: normalizedChecksum(
      value.fromPolicyChecksum,
      `${label}.fromPolicyChecksum`
    ),
    fromPolicyEffectiveFrom,
    fromPolicyEffectiveUntil,
    fromPolicyId: String(value.fromPolicyId).toLowerCase(),
    fromPolicySigningKeyId: String(value.fromPolicySigningKeyId || '').trim(),
    fromPolicySupersedesId:
      value.fromPolicySupersedesId === null
        ? null
        : String(value.fromPolicySupersedesId || '').toLowerCase(),
    fromPolicyVersion: normalizeGovernanceVersion(value.fromPolicyVersion),
    fromRevocationEpoch: normalizeGovernanceVersion(value.fromRevocationEpoch, {
      allowZero: true
    }),
    fromRegistryChecksum: normalizedChecksum(
      value.fromRegistryChecksum,
      `${label}.fromRegistryChecksum`
    ),
    fromRegistryVersion: normalizeGovernanceVersion(value.fromRegistryVersion),
    maximumCaptureAgeMinutes,
    outcome: value.outcome
  };
}

function registryWithoutChecksum(value) {
  const copy = { ...value };
  delete copy.registryChecksum;
  return copy;
}

export function parseClinicalContinuityActionRegistry(
  value,
  { effectiveFrom, effectiveUntil } = {}
) {
  exactKeys(
    value,
    [
      'actions',
      'activation',
      'approvalEvidence',
      'audience',
      'compatibilityRules',
      'expiresAt',
      'issuedAt',
      'minimumAppVersions',
      'registryChecksum',
      'registrySchemaVersion',
      'registryVersion'
    ],
    'actionRegistry'
  );
  if (value.registrySchemaVersion !== CLINICAL_CONTINUITY_ACTION_REGISTRY_SCHEMA_VERSION) {
    registryConflict('Action registry schema version is unsupported');
  }
  const registryVersion = normalizeGovernanceVersion(value.registryVersion);
  const issuedAt = normalizedTimestamp(value.issuedAt, 'actionRegistry.issuedAt');
  const expiresAt = normalizedTimestamp(value.expiresAt, 'actionRegistry.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    registryConflict('Action registry expiry must be later than issue time');
  }
  if (effectiveFrom && issuedAt !== effectiveFrom) {
    registryConflict('Action registry issue time must match policy effectiveFrom');
  }
  if (!effectiveUntil || expiresAt !== effectiveUntil) {
    registryConflict('Capture policy requires a finite registry expiry matching effectiveUntil');
  }

  exactKeys(value.audience, ['devicePostures'], 'actionRegistry.audience');
  if (
    !Array.isArray(value.audience.devicePostures) ||
    value.audience.devicePostures.length === 0 ||
    value.audience.devicePostures.some(posture => !APP_POSTURES.has(posture)) ||
    new Set(value.audience.devicePostures).size !== value.audience.devicePostures.length
  ) {
    registryConflict('Action registry device posture audience is invalid');
  }

  exactKeys(value.minimumAppVersions, ['desktop', 'tablet'], 'actionRegistry.minimumAppVersions');
  const minimumAppVersions = {
    desktop: normalizedSemver(
      value.minimumAppVersions.desktop,
      'actionRegistry.minimumAppVersions.desktop'
    ),
    tablet: normalizedSemver(
      value.minimumAppVersions.tablet,
      'actionRegistry.minimumAppVersions.tablet'
    )
  };

  exactKeys(value.activation, ['enforcedActionIds', 'mode'], 'actionRegistry.activation');
  if (!ACTIVATION_MODES.has(value.activation.mode)) {
    registryConflict('Action registry activation mode is invalid');
  }
  if (!Array.isArray(value.activation.enforcedActionIds)) {
    registryConflict('Action registry enforcedActionIds must be an array');
  }
  const enforcedActionIds = [...value.activation.enforcedActionIds].sort();
  if (
    new Set(enforcedActionIds).size !== enforcedActionIds.length ||
    enforcedActionIds.some(actionId => !CLINICAL_CONTINUITY_ACTIONS_BY_ID[actionId])
  ) {
    registryConflict('Action registry enforcedActionIds contains duplicates or unknown actions');
  }
  if (value.activation.mode === 'shadow' && enforcedActionIds.length !== 0) {
    registryConflict('Shadow action registry cannot declare enforced actions');
  }

  exactKeys(
    value.approvalEvidence,
    ['countersignedAt', 'decisionId', 'source'],
    'actionRegistry.approvalEvidence'
  );
  if (
    value.approvalEvidence.decisionId !== 'C-D3' ||
    value.approvalEvidence.countersignedAt !== '2026-07-30' ||
    value.approvalEvidence.source !==
      'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
  ) {
    registryConflict('Action registry approval evidence does not match countersigned C-D3');
  }

  const actions = normalizeActionEntries(value.actions);
  if (!Array.isArray(value.compatibilityRules)) {
    registryConflict('Action registry compatibilityRules must be an array');
  }
  const compatibilityRules = value.compatibilityRules.map(normalizeCompatibilityRule);
  const compatibilityKeys = compatibilityRules.map(rule =>
    [
      rule.fromPolicyId,
      rule.fromPolicyVersion,
      rule.fromRegistryVersion,
      rule.actionId,
      rule.actionVersion
    ].join(':')
  );
  if (new Set(compatibilityKeys).size !== compatibilityKeys.length) {
    registryConflict('Action registry compatibility rules must be exact and unique');
  }

  const normalized = {
    actions,
    activation: {
      enforcedActionIds,
      mode: value.activation.mode
    },
    approvalEvidence: { ...value.approvalEvidence },
    audience: {
      devicePostures: [...value.audience.devicePostures].sort()
    },
    compatibilityRules,
    expiresAt,
    issuedAt,
    minimumAppVersions,
    registryChecksum: normalizedChecksum(
      value.registryChecksum,
      'actionRegistry.registryChecksum'
    ),
    registrySchemaVersion: CLINICAL_CONTINUITY_ACTION_REGISTRY_SCHEMA_VERSION,
    registryVersion
  };
  if (hashCanonicalValue(registryWithoutChecksum(normalized)) !== normalized.registryChecksum) {
    registryConflict(
      'Action registry checksum does not match its canonical content',
      'CONTINUITY_ACTION_REGISTRY_CHECKSUM_MISMATCH'
    );
  }
  return Object.freeze(JSON.parse(canonicalizeJson(normalized)));
}

function decision({ mode, action, decision, reasonCode, proceed }) {
  return Object.freeze({
    actionId: action?.actionId || 'unknown',
    decision,
    mode,
    owner: action?.quarantineOwnership?.owner || 'clinical_continuity_governance',
    proceed,
    reasonCode
  });
}

function finish(mode, action, desiredDecision, reasonCode) {
  if (mode === 'shadow' && desiredDecision !== 'allow') {
    return decision({
      mode,
      action,
      decision: 'would_deny',
      reasonCode,
      proceed: true
    });
  }
  return decision({
    mode,
    action,
    decision: desiredDecision,
    reasonCode,
    proceed: desiredDecision === 'allow'
  });
}

function exactCompatibilityRule({ registry, capturedPolicy, action, capturedAt, trustedNow }) {
  const ageMinutes = (Date.parse(trustedNow) - Date.parse(capturedAt)) / 60_000;
  return registry.compatibilityRules.find(
    rule =>
      rule.fromPolicyId === capturedPolicy.id &&
      rule.fromPolicyVersion === capturedPolicy.policyVersion &&
      rule.fromPolicyChecksum === capturedPolicy.policyChecksum &&
      rule.fromPolicyEffectiveFrom === capturedPolicy.effectiveFrom &&
      rule.fromPolicyEffectiveUntil === capturedPolicy.effectiveUntil &&
      rule.fromPolicySigningKeyId === capturedPolicy.policySigningKeyId &&
      rule.fromPolicySupersedesId === capturedPolicy.supersedesPolicyId &&
      rule.fromRevocationEpoch === capturedPolicy.revocationEpoch &&
      rule.fromRegistryVersion === capturedPolicy.actionRegistryVersion &&
      rule.fromRegistryChecksum === capturedPolicy.actionRegistryChecksum &&
      rule.actionId === action.actionId &&
      rule.actionVersion === action.actionVersion &&
      rule.actionChecksum === action.actionChecksum &&
      rule.actionSchemaVersion === action.actionSchema.version &&
      rule.actionSchemaChecksum === action.actionSchema.checksum &&
      ageMinutes >= 0 &&
      ageMinutes <= rule.maximumCaptureAgeMinutes
  );
}

export function evaluateClinicalContinuityAction({
  currentPolicy,
  capturedPolicy,
  actionId,
  binding,
  actorRole,
  actorCapabilities = [],
  devicePosture,
  clientAppVersion,
  capturedAt,
  trustedNow,
  authorityClaims,
  body,
  identitySatisfied = false,
  cachedSourcesSatisfied = false
}) {
  const registry = currentPolicy?.policyDocument?.actionRegistry;
  if (!registry || currentPolicy.policySchemaVersion !== 3) {
    return decision({
      mode: 'enforce',
      action: null,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_POLICY_V3_REQUIRED',
      proceed: false
    });
  }
  const mode = registry.activation.mode;
  const action = CLINICAL_CONTINUITY_ACTIONS_BY_ID[actionId];
  if (!action) {
    return decision({
      mode,
      action: null,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_UNKNOWN',
      proceed: false
    });
  }
  if (mode === 'enforce' && !registry.activation.enforcedActionIds.includes(actionId)) {
    return finish(mode, action, 'deny', 'CONTINUITY_ACTION_NOT_IN_ENFORCED_SET');
  }
  if (!binding || binding.actionId !== actionId) {
    return decision({
      mode,
      action,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_BINDING_MISMATCH',
      proceed: false
    });
  }
  if (!action.classification.captureReady || action.replayEndpoint.bindingId === 'none') {
    return decision({
      mode,
      action,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_NOT_CAPTURE_READY',
      proceed: false
    });
  }
  if (!action.allowedRoles.includes(String(actorRole || '').toUpperCase())) {
    return finish(mode, action, 'deny', 'CONTINUITY_ACTION_ROLE_DENIED');
  }
  if (
    !action.requiredCapabilities.every(capability => actorCapabilities.includes(capability))
  ) {
    return finish(mode, action, 'deny', 'CONTINUITY_ACTION_CAPABILITY_DENIED');
  }
  if (!registry.audience.devicePostures.includes(devicePosture)) {
    return decision({
      mode,
      action,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_DEVICE_POSTURE_DENIED',
      proceed: false
    });
  }
  if (!SEMVER_PATTERN.test(String(clientAppVersion || ''))) {
    return decision({
      mode,
      action,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_APP_VERSION_INVALID',
      proceed: false
    });
  }
  if (compareSemver(clientAppVersion, registry.minimumAppVersions[devicePosture]) < 0) {
    return decision({
      mode,
      action,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_APP_VERSION_UNSAFE',
      proceed: false
    });
  }
  const claims = authorityClaims || {};
  if (
    claims.policyId !== capturedPolicy?.id ||
    claims.policyVersion !== capturedPolicy?.policyVersion ||
    claims.policyChecksum !== capturedPolicy?.policyChecksum ||
    claims.policySigningKeyId !== capturedPolicy?.policySigningKeyId ||
    claims.policyEffectiveFrom !== capturedPolicy?.effectiveFrom ||
    claims.policyEffectiveUntil !== capturedPolicy?.effectiveUntil ||
    claims.policySupersedesId !== capturedPolicy?.supersedesPolicyId ||
    claims.revocationEpoch !== capturedPolicy?.revocationEpoch ||
    claims.registryVersion !== capturedPolicy?.actionRegistryVersion ||
    claims.registryChecksum !== capturedPolicy?.actionRegistryChecksum ||
    claims.actionVersion !== action.actionVersion ||
    claims.actionChecksum !== action.actionChecksum ||
    claims.actionSchemaVersion !== action.actionSchema.version ||
    claims.actionSchemaChecksum !== action.actionSchema.checksum
  ) {
    return decision({
      mode,
      action,
      decision: 'deny',
      reasonCode: 'CONTINUITY_ACTION_SIGNED_AUDIENCE_MISMATCH',
      proceed: false
    });
  }
  if (!identitySatisfied) {
    return finish(mode, action, 'needs_review', 'CONTINUITY_ACTION_IDENTITY_INCOMPLETE');
  }
  if (!cachedSourcesSatisfied) {
    return finish(mode, action, 'needs_review', 'CONTINUITY_ACTION_SOURCE_STALE_OR_MISSING');
  }
  if (
    action.actionSchema.id !== 'none' &&
    !validateClinicalContinuityActionBody(action.actionSchema.id, body).ok
  ) {
    return finish(mode, action, 'needs_review', 'CONTINUITY_ACTION_SCHEMA_INVALID');
  }

  const samePolicy =
    capturedPolicy?.id === currentPolicy.id &&
    capturedPolicy?.policyVersion === currentPolicy.policyVersion &&
    capturedPolicy?.policyChecksum === currentPolicy.policyChecksum &&
    capturedPolicy?.actionRegistryVersion === currentPolicy.actionRegistryVersion &&
    capturedPolicy?.actionRegistryChecksum === currentPolicy.actionRegistryChecksum;
  if (!samePolicy) {
    if (
      !capturedPolicy ||
      capturedPolicy.trustState === 'compromised' ||
      capturedPolicy.trustState === 'revoked' ||
      capturedPolicy.trustState === 'invalid' ||
      currentPolicy.revokedKeyIds.includes(capturedPolicy.policySigningKeyId)
    ) {
      return finish(mode, action, 'needs_review', 'CONTINUITY_ACTION_CAPTURE_POLICY_UNTRUSTED');
    }
    const rule = exactCompatibilityRule({
      registry,
      capturedPolicy,
      action,
      capturedAt,
      trustedNow
    });
    if (!rule) {
      return finish(mode, action, 'needs_review', 'CONTINUITY_ACTION_COMPATIBILITY_MISSING');
    }
    if (rule.outcome !== 'allow') {
      return finish(mode, action, 'needs_review', 'CONTINUITY_ACTION_COMPATIBILITY_REVIEW');
    }
  }
  return finish(mode, action, 'allow', 'CONTINUITY_ACTION_ALLOWED');
}

export function buildClinicalContinuityAuditMetadata(value) {
  const actionId = CLINICAL_CONTINUITY_ACTIONS_BY_ID[value.actionId]
    ? value.actionId
    : 'unknown';
  const safeChecksum = checksum =>
    typeof checksum === 'string' && CHECKSUM_PATTERN.test(checksum) ? checksum : null;
  const safeVersion = version =>
    /^(0|[1-9][0-9]*)$/.test(String(version ?? '')) ? String(version) : null;
  const safeUuid = uuid => {
    const normalized = String(uuid || '').toLowerCase();
    return UUID_PATTERN.test(normalized) ? normalized : null;
  };
  return Object.freeze({
    action_checksum: safeChecksum(value.actionChecksum),
    action_id: actionId,
    action_schema_checksum: safeChecksum(value.actionSchemaChecksum),
    action_schema_version: safeVersion(value.actionSchemaVersion),
    action_version: safeVersion(value.actionVersion),
    client_app_version: SEMVER_PATTERN.test(String(value.clientAppVersion || ''))
      ? value.clientAppVersion
      : null,
    decision: AUDIT_DECISIONS.has(value.decision) ? value.decision : 'deny',
    device_posture: APP_POSTURES.has(value.devicePosture) ? value.devicePosture : null,
    facility_id:
      Number.isSafeInteger(Number(value.facilityId)) && Number(value.facilityId) > 0
        ? Number(value.facilityId)
        : null,
    policy_id: safeUuid(value.policyId),
    policy_version: safeVersion(value.policyVersion),
    reason_code: /^[A-Z0-9_]{1,100}$/.test(String(value.reasonCode || ''))
      ? value.reasonCode
      : 'CONTINUITY_ACTION_DENIED',
    registry_checksum: safeChecksum(value.registryChecksum),
    registry_version: safeVersion(value.registryVersion),
    request_id: safeUuid(value.requestId),
    review_owner: AUDIT_OWNERS.has(value.reviewOwner) ? value.reviewOwner : null,
    route_template: AUDIT_ROUTE_TEMPLATES.has(value.routeTemplate)
      ? value.routeTemplate
      : 'unmatched'
  });
}

export async function auditClinicalContinuityActionDecision({
  tx,
  actorUid,
  actorRole,
  value
}) {
  if (!tx?.audit_logs?.create) {
    throw new Error('Clinical continuity audit requires a tenant-scoped Prisma transaction');
  }
  const metadata = buildClinicalContinuityAuditMetadata(value);
  const safeActorUid =
    typeof actorUid === 'string' && UUID_PATTERN.test(actorUid.toLowerCase())
      ? actorUid.toLowerCase()
      : null;
  const safeActorRole = /^[A-Z0-9_]{1,64}$/.test(String(actorRole || ''))
    ? actorRole
    : null;
  return tx.audit_logs.create({
    data: {
      uid: safeActorUid,
      actor_uid: safeActorUid,
      role: safeActorRole,
      action: `CONTINUITY_ACTION_${metadata.decision.toUpperCase()}`,
      resource: 'clinical_continuity_action_policy',
      resource_id: metadata.action_id,
      metadata
    }
  });
}

export async function evaluateClinicalContinuityActionRequest({
  tenantId,
  facilityId,
  capturedPolicyId,
  capturedPolicyVersion,
  requestContext,
  scopeRunner = setTenantTx,
  activePolicyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
  historicalPolicyLoader = loadHistoricalClinicalContinuityPolicyForActionTx
}) {
  return scopeRunner(
    tenantId,
    async tx => {
      let result;
      let currentPolicy = null;
      try {
        currentPolicy = await activePolicyLoader({
          tx,
          tenantId,
          facilityId
        });
        const action = CLINICAL_CONTINUITY_ACTIONS_BY_ID[requestContext.actionId];
        if (!action) {
          result = decision({
            mode: currentPolicy.policyDocument?.actionRegistry?.activation?.mode || 'enforce',
            action: null,
            decision: 'deny',
            proceed: false,
            reasonCode: 'CONTINUITY_ACTION_UNKNOWN'
          });
        } else {
          let capturedPolicy;
          try {
            capturedPolicy =
              String(capturedPolicyId || '').toLowerCase() === currentPolicy.id &&
              String(capturedPolicyVersion) === currentPolicy.policyVersion
                ? { ...currentPolicy, trustState: 'current' }
                : await historicalPolicyLoader({
                    tx,
                    tenantId,
                    facilityId,
                    policyId: capturedPolicyId,
                    policyVersion: capturedPolicyVersion,
                    capturedAt: requestContext.capturedAt
                  });
          } catch (error) {
            result = finish(
              currentPolicy.policyDocument?.actionRegistry?.activation?.mode || 'enforce',
              action,
              'needs_review',
              error?.code || 'CONTINUITY_ACTION_CAPTURE_POLICY_UNTRUSTED'
            );
          }
          if (capturedPolicy) {
            result = evaluateClinicalContinuityAction({
              currentPolicy,
              capturedPolicy,
              ...requestContext,
              trustedNow: currentPolicy.trustedNow
            });
          }
        }
      } catch (error) {
        result = decision({
          mode: 'enforce',
          action: CLINICAL_CONTINUITY_ACTIONS_BY_ID[requestContext.actionId],
          decision: 'deny',
          proceed: false,
          reasonCode: error?.code || 'CONTINUITY_ACTION_POLICY_EVALUATION_FAILED'
        });
      }

      if (result.decision !== 'allow') {
        const action = CLINICAL_CONTINUITY_ACTIONS_BY_ID[requestContext.actionId];
        await auditClinicalContinuityActionDecision({
          tx,
          actorUid: requestContext.actorUid,
          actorRole: requestContext.actorRole,
          value: {
            actionChecksum: action?.actionChecksum,
            actionId: requestContext.actionId,
            actionSchemaChecksum: action?.actionSchema?.checksum,
            actionSchemaVersion: action?.actionSchema?.version,
            actionVersion: action?.actionVersion,
            clientAppVersion: requestContext.clientAppVersion,
            decision: result.decision,
            devicePosture: requestContext.devicePosture,
            facilityId,
            policyId: currentPolicy?.id || capturedPolicyId,
            policyVersion: currentPolicy?.policyVersion || capturedPolicyVersion,
            reasonCode: result.reasonCode,
            registryChecksum: currentPolicy?.actionRegistryChecksum || null,
            registryVersion: currentPolicy?.actionRegistryVersion || null,
            requestId: requestContext.requestId,
            reviewOwner: result.owner,
            routeTemplate: requestContext.routeTemplate
          }
        });
      }
      return result;
    },
    {
      isolationLevel: 'RepeatableRead',
      readOnly: false
    }
  );
}
