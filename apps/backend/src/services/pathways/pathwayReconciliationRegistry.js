import { createHash } from 'node:crypto';

import {
  CANONICAL_PATHWAY_KEYS,
  CARE_PATHWAY_KEYS,
} from './pathwayMode.js';
import { compileDiagnosticsOrderToActionDefinition } from './diagnosticsPathwayDefinition.js';
import { compileReferralRequestToClosureDefinition } from './referralPathwayDefinition.js';
import {
  COMMON_PATHWAY_RECONCILIATION_CHECKS,
  DIAGNOSTIC_PATHWAY_RECONCILIATION_CHECKS,
  REFERRAL_PATHWAY_RECONCILIATION_CHECKS,
} from './pathwayReconciliationChecks.js';

const ID_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const HANDLER_VERSION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.v[1-9][0-9]*$/;
const SOURCE_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const canonicalKeySet = new Set(CANONICAL_PATHWAY_KEYS);
const brandedRegistries = new WeakSet();

function plainObject(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function canonicalId(value, label, pattern = ID_PATTERN) {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || !pattern.test(value)
    || value.includes('*')
  ) {
    throw new TypeError(`${label} must be an exact canonical identifier`);
  }
  return value;
}

function handlerVersion(value, label) {
  return canonicalId(value, label, HANDLER_VERSION_PATTERN);
}

function exactChecksum(value, label) {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 checksum`);
  }
  return value;
}

function nonEmptyText(value, label, max = 240) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.trim() !== value
    || value.length > max
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function computeCanonicalChecksum(value) {
  return sha256(value);
}

function normalizeCheck(descriptor, label) {
  const value = plainObject(descriptor, label);
  const id = canonicalId(value.id, `${label}.id`);
  const version = handlerVersion(value.handlerVersion, `${label}.handlerVersion`);
  if (typeof value.run !== 'function') {
    throw new TypeError(`${label}.run must be a function`);
  }
  return Object.freeze({ id, handlerVersion: version, run: value.run });
}

function normalizeCommonChecks(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('Pathway reconciliation commonChecks must be a non-empty array');
  }
  const checks = new Map();
  for (const entry of entries) {
    const check = normalizeCheck(entry, 'Pathway reconciliation common check');
    if (checks.has(check.id)) throw new TypeError(`Duplicate reconciliation check id: ${check.id}`);
    checks.set(check.id, check);
  }
  return checks;
}

function normalizeDomainAdapter(value, pathwayKey, knownCheckIds) {
  const descriptor = plainObject(value, `Domain adapter for ${pathwayKey}`);
  const adapterId = canonicalId(descriptor.adapterId, 'Domain adapter id');
  const adapterVersion = handlerVersion(descriptor.adapterVersion, 'Domain adapter version');
  const workflowKey = canonicalId(descriptor.workflowKey, 'Domain adapter workflowKey');
  if (workflowKey !== pathwayKey) {
    throw new TypeError(`Domain adapter ${adapterId} workflowKey must match ${pathwayKey}`);
  }
  const definitionVersion = positiveInteger(
    descriptor.definitionVersion,
    'Domain adapter definitionVersion',
  );
  const definitionChecksum = exactChecksum(
    descriptor.definitionChecksum,
    'Domain adapter definitionChecksum',
  );
  if (!Array.isArray(descriptor.checks) || descriptor.checks.length === 0) {
    throw new TypeError(`Domain adapter ${adapterId} must register at least one check`);
  }
  const checks = descriptor.checks.map((entry) => normalizeCheck(
    entry,
    `Domain adapter ${adapterId} check`,
  ));
  for (const check of checks) {
    if (knownCheckIds.has(check.id)) {
      throw new TypeError(`Duplicate reconciliation check id: ${check.id}`);
    }
    knownCheckIds.add(check.id);
  }
  return Object.freeze({
    adapterId,
    adapterVersion,
    workflowKey,
    definitionVersion,
    definitionChecksum,
    checks: Object.freeze(checks),
  });
}

function normalizeRepairDescriptor(value, pathwayKey) {
  const descriptor = plainObject(value, `Repair descriptor for ${pathwayKey}`);
  const ruleCode = canonicalId(descriptor.ruleCode, 'Repair ruleCode');
  const sourceTable = canonicalId(descriptor.sourceTable, 'Repair sourceTable', SOURCE_PATTERN);
  const version = handlerVersion(descriptor.handlerVersion, 'Repair handlerVersion');
  if (descriptor.enabled !== true && descriptor.enabled !== false) {
    throw new TypeError('Repair descriptor enabled must be boolean');
  }
  for (const callback of ['findCandidates', 'validateSource', 'resolveOwner', 'materializeTask']) {
    if (typeof descriptor[callback] !== 'function') {
      throw new TypeError(`Repair descriptor ${ruleCode}/${sourceTable} requires ${callback}()`);
    }
  }
  return Object.freeze({
    ruleCode,
    sourceTable,
    handlerVersion: version,
    enabled: descriptor.enabled,
    findCandidates: descriptor.findCandidates,
    validateSource: descriptor.validateSource,
    resolveOwner: descriptor.resolveOwner,
    materializeTask: descriptor.materializeTask,
  });
}

function normalizeExclusion(value, pathwayKey) {
  const descriptor = plainObject(value, `Clock exclusion for ${pathwayKey}`);
  return Object.freeze({
    ruleCode: canonicalId(descriptor.ruleCode, 'Clock exclusion ruleCode'),
    sourceTable: canonicalId(descriptor.sourceTable, 'Clock exclusion sourceTable', SOURCE_PATTERN),
    ownerEvidenceRef: nonEmptyText(descriptor.ownerEvidenceRef, 'Clock exclusion ownerEvidenceRef'),
  });
}

function pairKey(ruleCode, sourceTable) {
  return `${ruleCode}\u0000${sourceTable}`;
}

function normalizeProfile(value, commonChecks, allCheckIds, allRuleSourcePairs) {
  const descriptor = plainObject(value, 'Pathway reconciliation profile');
  const pathwayKey = canonicalId(descriptor.pathwayKey, 'Pathway profile pathwayKey');
  if (!canonicalKeySet.has(pathwayKey)) {
    throw new TypeError(`Unknown canonical pathway key: ${pathwayKey}`);
  }
  const profileVersion = positiveInteger(descriptor.profileVersion, `${pathwayKey}.profileVersion`);
  if (!Array.isArray(descriptor.commonCheckIds) || descriptor.commonCheckIds.length === 0) {
    throw new TypeError(`${pathwayKey}.commonCheckIds must be a non-empty array`);
  }
  const commonCheckIds = [];
  const seenCommon = new Set();
  for (const valueId of descriptor.commonCheckIds) {
    const id = canonicalId(valueId, `${pathwayKey}.commonCheckIds`);
    if (!commonChecks.has(id)) throw new TypeError(`${pathwayKey} references unknown check ${id}`);
    if (seenCommon.has(id)) throw new TypeError(`${pathwayKey} repeats common check ${id}`);
    seenCommon.add(id);
    commonCheckIds.push(id);
  }
  if (!Array.isArray(descriptor.domainAdapters)) {
    throw new TypeError(`${pathwayKey}.domainAdapters must be an array`);
  }
  const adapters = [];
  const adapterIds = new Set();
  const adapterTuples = new Set();
  for (const entry of descriptor.domainAdapters) {
    const adapter = normalizeDomainAdapter(entry, pathwayKey, allCheckIds);
    const tuple = [
      adapter.workflowKey,
      adapter.definitionVersion,
      adapter.definitionChecksum,
    ].join(':');
    if (adapterIds.has(adapter.adapterId)) {
      throw new TypeError(`Duplicate domain adapter id: ${adapter.adapterId}`);
    }
    if (adapterTuples.has(tuple)) {
      throw new TypeError(`Duplicate domain adapter governance tuple for ${pathwayKey}`);
    }
    adapterIds.add(adapter.adapterId);
    adapterTuples.add(tuple);
    adapters.push(adapter);
  }
  if (!Array.isArray(descriptor.repairDescriptors)) {
    throw new TypeError(`${pathwayKey}.repairDescriptors must be an array`);
  }
  if (!Array.isArray(descriptor.excludedClocks)) {
    throw new TypeError(`${pathwayKey}.excludedClocks must be an array`);
  }
  const repairs = descriptor.repairDescriptors.map((entry) => (
    normalizeRepairDescriptor(entry, pathwayKey)
  ));
  const exclusions = descriptor.excludedClocks.map((entry) => normalizeExclusion(entry, pathwayKey));
  for (const descriptorEntry of [...repairs, ...exclusions]) {
    const key = pairKey(descriptorEntry.ruleCode, descriptorEntry.sourceTable);
    if (allRuleSourcePairs.has(key)) {
      throw new TypeError(`Duplicate rule/source registration: ${descriptorEntry.ruleCode}/${descriptorEntry.sourceTable}`);
    }
    allRuleSourcePairs.add(key);
  }
  const blockingReason = descriptor.blockingReason == null
    ? null
    : canonicalId(descriptor.blockingReason, `${pathwayKey}.blockingReason`);
  if (adapters.length === 0 && !blockingReason) {
    throw new TypeError(`${pathwayKey} requires an explicit blockingReason without domain adapters`);
  }
  return Object.freeze({
    pathwayKey,
    profileVersion,
    commonCheckIds: Object.freeze(commonCheckIds),
    domainAdapters: Object.freeze(adapters),
    repairDescriptors: Object.freeze(repairs),
    excludedClocks: Object.freeze(exclusions),
    blockingReason,
  });
}

function checkManifest(check) {
  return { id: check.id, handler_version: check.handlerVersion };
}

function profileManifest(profile) {
  return {
    pathway_key: profile.pathwayKey,
    profile_version: profile.profileVersion,
    common_check_ids: [...profile.commonCheckIds],
    blocking_reason: profile.blockingReason,
    domain_adapters: profile.domainAdapters.map((adapter) => ({
      adapter_id: adapter.adapterId,
      adapter_version: adapter.adapterVersion,
      workflow_key: adapter.workflowKey,
      definition_version: adapter.definitionVersion,
      definition_checksum: adapter.definitionChecksum,
      checks: adapter.checks.map(checkManifest),
    })),
    repair_descriptors: profile.repairDescriptors.map((repair) => ({
      rule_code: repair.ruleCode,
      source_table: repair.sourceTable,
      handler_version: repair.handlerVersion,
      enabled: repair.enabled,
    })),
    excluded_clocks: profile.excludedClocks.map((clock) => ({
      rule_code: clock.ruleCode,
      source_table: clock.sourceTable,
      owner_evidence_ref: clock.ownerEvidenceRef,
    })),
  };
}

export function createPathwayReconciliationRegistry({
  version,
  commonChecks,
  profiles,
} = {}) {
  const normalizedVersion = positiveInteger(version, 'Pathway reconciliation registry version');
  const commonById = normalizeCommonChecks(commonChecks);
  if (!Array.isArray(profiles)) {
    throw new TypeError('Pathway reconciliation profiles must be an array');
  }
  const allCheckIds = new Set(commonById.keys());
  const allRuleSourcePairs = new Set();
  const profilesByKey = new Map();
  for (const entry of profiles) {
    const profile = normalizeProfile(entry, commonById, allCheckIds, allRuleSourcePairs);
    if (profilesByKey.has(profile.pathwayKey)) {
      throw new TypeError(`Duplicate pathway reconciliation profile: ${profile.pathwayKey}`);
    }
    profilesByKey.set(profile.pathwayKey, profile);
  }
  if (
    profilesByKey.size !== CANONICAL_PATHWAY_KEYS.length
    || CANONICAL_PATHWAY_KEYS.some((key) => !profilesByKey.has(key))
  ) {
    throw new TypeError('Pathway reconciliation registry must contain all six canonical pathway keys');
  }

  const manifest = deepFreeze({
    version: normalizedVersion,
    common_checks:
      [...commonById.values()].map(checkManifest).sort((a, b) => a.id.localeCompare(b.id)),
    profiles: CANONICAL_PATHWAY_KEYS.map((key) => profileManifest(profilesByKey.get(key))),
  });
  const checksum = sha256(manifest);
  const registry = Object.freeze({
    version: normalizedVersion,
    checksum,
    manifest,
    pathwayKeys: CANONICAL_PATHWAY_KEYS,
    resolveProfile(pathwayKey) {
      return typeof pathwayKey === 'string' ? profilesByKey.get(pathwayKey) : undefined;
    },
    resolveCommonCheck(checkId) {
      return typeof checkId === 'string' ? commonById.get(checkId) : undefined;
    },
    matchDomainAdapter(pathwayKey, tuple = {}) {
      const profile = profilesByKey.get(pathwayKey);
      if (!profile) return undefined;
      return profile.domainAdapters.find((adapter) => (
        adapter.workflowKey === pathwayKey
        && adapter.definitionVersion === Number(tuple.definitionVersion)
        && adapter.definitionChecksum === tuple.definitionChecksum
      ));
    },
    resolveRepair(pathwayKey, ruleCode, sourceTable) {
      return profilesByKey.get(pathwayKey)?.repairDescriptors.find((repair) => (
        repair.ruleCode === ruleCode && repair.sourceTable === sourceTable
      ));
    },
    resolveClockExclusion(pathwayKey, ruleCode, sourceTable) {
      return profilesByKey.get(pathwayKey)?.excludedClocks.find((clock) => (
        clock.ruleCode === ruleCode && clock.sourceTable === sourceTable
      ));
    },
  });
  brandedRegistries.add(registry);
  return registry;
}

export function isPathwayReconciliationRegistry(value) {
  return Boolean(value && typeof value === 'object' && brandedRegistries.has(value));
}

const COMMON_CHECK_IDS = Object.freeze(
  COMMON_PATHWAY_RECONCILIATION_CHECKS.map((check) => check.id),
);

const NO_VERTICAL_ADAPTER = 'vertical_domain_adapter_not_registered';
const PORTER_EXCLUSIONS = Object.freeze([
  'porter_transport_general',
  'porter_transport_discharge',
  'porter_transport_sample',
  'porter_transport_transfer',
  'porter_transport_equipment',
].map((ruleCode) => Object.freeze({
  ruleCode,
  sourceTable: 'porter_transport_tasks',
  ownerEvidenceRef: 'porter_transport_domain_authority',
})));
const EMERGENCY_CLOCK_EXCLUSIONS = Object.freeze([
  ['stroke_door_to_ct', 'stroke_activations', 'stroke_pathway_domain_authority'],
  ['stroke_door_to_needle', 'stroke_activations', 'stroke_pathway_domain_authority'],
  ['stemi_door_to_ecg', 'stemi_activations', 'stemi_pathway_domain_authority'],
  ['stemi_door_to_lab', 'stemi_activations', 'stemi_pathway_domain_authority'],
  ['stemi_door_to_balloon', 'stemi_activations', 'stemi_pathway_domain_authority'],
].map(([ruleCode, sourceTable, ownerEvidenceRef]) => Object.freeze({
  ruleCode,
  sourceTable,
  ownerEvidenceRef,
})));

const diagnosticsDefinition = compileDiagnosticsOrderToActionDefinition();
const DIAGNOSTICS_ADAPTER = Object.freeze({
  adapterId: 'diagnostics_order_to_action_v1',
  adapterVersion: 'diagnostics.reconciliation_adapter.v1',
  workflowKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
  definitionVersion: diagnosticsDefinition.version,
  definitionChecksum: diagnosticsDefinition.checksum,
  checks: DIAGNOSTIC_PATHWAY_RECONCILIATION_CHECKS,
});

const referralDefinition = compileReferralRequestToClosureDefinition();
const REFERRAL_ADAPTER = Object.freeze({
  adapterId: 'referral_request_to_closure_v1',
  adapterVersion: 'referral.reconciliation_adapter.v1',
  workflowKey: CARE_PATHWAY_KEYS.REFERRAL,
  definitionVersion: referralDefinition.version,
  definitionChecksum: referralDefinition.checksum,
  checks: REFERRAL_PATHWAY_RECONCILIATION_CHECKS,
});

const productionProfiles = CANONICAL_PATHWAY_KEYS.map((pathwayKey) => ({
  pathwayKey,
  profileVersion: pathwayKey === CARE_PATHWAY_KEYS.DIAGNOSTICS
    ? 2
    : pathwayKey === CARE_PATHWAY_KEYS.REFERRAL
      ? 2
      : 1,
  commonCheckIds: COMMON_CHECK_IDS,
  domainAdapters: pathwayKey === CARE_PATHWAY_KEYS.DIAGNOSTICS
    ? [DIAGNOSTICS_ADAPTER]
    : pathwayKey === CARE_PATHWAY_KEYS.REFERRAL
      ? [REFERRAL_ADAPTER]
      : [],
  repairDescriptors: [],
  excludedClocks: pathwayKey === CARE_PATHWAY_KEYS.EMERGENCY
    ? EMERGENCY_CLOCK_EXCLUSIONS
    : pathwayKey === CARE_PATHWAY_KEYS.INPATIENT
      ? PORTER_EXCLUSIONS
      : [],
  blockingReason: [CARE_PATHWAY_KEYS.DIAGNOSTICS, CARE_PATHWAY_KEYS.REFERRAL].includes(pathwayKey)
    ? null
    : NO_VERTICAL_ADAPTER,
}));

export const pathwayReconciliationRegistry = createPathwayReconciliationRegistry({
  version: 4,
  commonChecks: COMMON_PATHWAY_RECONCILIATION_CHECKS,
  profiles: productionProfiles,
});

export default pathwayReconciliationRegistry;
