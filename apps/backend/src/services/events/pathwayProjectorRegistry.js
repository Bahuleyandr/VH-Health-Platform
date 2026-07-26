import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../../config/pathwayProjectorConfig.js';
import {
  DIAGNOSTIC_PATHWAY_EVENT_TYPES,
  diagnosticPathwayProjectorHandler,
} from '../pathways/diagnosticPathwayProjector.js';
import {
  INPATIENT_PATHWAY_EVENT_TYPES,
  inpatientPathwayProjectorHandler,
} from '../pathways/inpatientPathwayProjector.js';
import {
  OP_PATHWAY_EVENT_TYPES,
  opPathwayProjectorHandler,
} from '../pathways/opPathwayProjector.js';
import {
  REFERRAL_PATHWAY_EVENT_TYPES,
  referralPathwayProjectorHandler,
} from '../pathways/referralPathwayProjector.js';

export {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../../config/pathwayProjectorConfig.js';

export const PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES = Object.freeze([
  'clinical.handover.created',
  'clinical.handover.acknowledged',
  'clinical.prehospital_handover.created',
  'clinical.prehospital_handover.accepted',
  'clinical_document.discharge_summary.saved',
  'clinical_document.discharge_summary.signed',
]);

export const PATHWAY_PROJECTOR_GENERATION_2_EVENT_TYPES = Object.freeze([
  ...PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES,
  ...DIAGNOSTIC_PATHWAY_EVENT_TYPES,
]);

export const PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES = Object.freeze([
  ...PATHWAY_PROJECTOR_GENERATION_2_EVENT_TYPES,
  ...REFERRAL_PATHWAY_EVENT_TYPES,
]);

export const PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES = Object.freeze([
  ...new Set([
    ...PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES,
    ...OP_PATHWAY_EVENT_TYPES,
    ...INPATIENT_PATHWAY_EVENT_TYPES,
  ]),
]);

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const registriesByGeneration = new Map();

function requireGeneration(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('Pathway projector generation must be a positive integer');
  }
  return value;
}

function requireEventType(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 120
    || value.trim() !== value
    || !EVENT_TYPE_PATTERN.test(value)
  ) {
    throw new TypeError('Pathway projector event type is malformed');
  }
  return value;
}

function requireGenerationMembership(generation, handlers) {
  const canonicalMembership = generation === 1
    ? PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES
    : generation === 2
      ? PATHWAY_PROJECTOR_GENERATION_2_EVENT_TYPES
      : generation === 3
        ? PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES
        : generation === 4
          ? PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES
          : null;
  if (!canonicalMembership) return;
  const exact = handlers.size === canonicalMembership.length
    && canonicalMembership.every((eventType) => handlers.has(eventType));
  if (!exact) {
    throw new TypeError(
      `Pathway projector generation ${generation} must contain exactly its frozen event types`,
    );
  }
}

/**
 * Build a generation-scoped, immutable exact-match handler registry.
 *
 * Entries are `[eventType, handler]` tuples. Construction copies every tuple
 * before retaining it, and the resolver is the registry's only lookup surface;
 * callers cannot add, replace, or remove handlers after construction.
 */
function buildPathwayProjectorRegistry({ generation, entries }, { allowCanonical = false } = {}) {
  const normalizedGeneration = requireGeneration(generation);
  if ([1, 2, 3, 4].includes(normalizedGeneration) && !allowCanonical) {
    throw new TypeError(
      `Pathway projector generation ${normalizedGeneration} is reserved for its canonical registry`,
    );
  }
  if (!Array.isArray(entries)) {
    throw new TypeError('Pathway projector registry entries must be an array');
  }

  const handlers = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('Pathway projector registry entries must be [eventType, handler] tuples');
    }
    const eventType = requireEventType(entry[0]);
    const handler = entry[1];
    if (typeof handler !== 'function') {
      throw new TypeError(`Pathway projector handler for ${eventType} must be a function`);
    }
    if (handlers.has(eventType)) {
      throw new TypeError(`Duplicate pathway projector event type: ${eventType}`);
    }
    handlers.set(eventType, handler);
  }

  requireGenerationMembership(normalizedGeneration, handlers);
  if (registriesByGeneration.has(normalizedGeneration)) {
    throw new TypeError(`Pathway projector generation ${normalizedGeneration} is already registered`);
  }

  const eventTypes = Object.freeze([...handlers.keys()]);
  const registry = Object.freeze({
    generation: normalizedGeneration,
    eventTypes,
    size: handlers.size,
    resolve(eventType) {
      return typeof eventType === 'string' ? handlers.get(eventType) : undefined;
    },
  });
  registriesByGeneration.set(normalizedGeneration, registry);
  return registry;
}

export function createPathwayProjectorRegistry(options) {
  return buildPathwayProjectorRegistry(options);
}

export function isPathwayProjectorRegistry(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && registriesByGeneration.get(value.generation) === value,
  );
}

function createShadowObserver(eventType, generation) {
  const observer = async function observeEvent() {
    return Object.freeze({
      consumer_key: PATHWAY_PROJECTOR_CONSUMER_KEY,
      generation,
      event_type: eventType,
      shadow_observed: true,
    });
  };
  return Object.freeze(observer);
}

const generationOneEntries = PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.map((eventType) =>
  Object.freeze([eventType, createShadowObserver(eventType, 1)]));

export const pathwayProjectorRegistryV1 = buildPathwayProjectorRegistry(
  { generation: 1, entries: generationOneEntries },
  { allowCanonical: true },
);

const generationTwoEntries = [
  ...PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, createShadowObserver(eventType, 2)])),
  ...DIAGNOSTIC_PATHWAY_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, diagnosticPathwayProjectorHandler])),
];

export const pathwayProjectorRegistryV2 = buildPathwayProjectorRegistry(
  {
    generation: 2,
    entries: generationTwoEntries,
  },
  { allowCanonical: true },
);

const generationThreeEntries = [
  ...PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, createShadowObserver(eventType, 3)])),
  ...DIAGNOSTIC_PATHWAY_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, diagnosticPathwayProjectorHandler])),
  ...REFERRAL_PATHWAY_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, referralPathwayProjectorHandler])),
];

export const pathwayProjectorRegistryV3 = buildPathwayProjectorRegistry(
  {
    generation: 3,
    entries: generationThreeEntries,
  },
  { allowCanonical: true },
);

const dischargeSummarySignedObserverV4 = createShadowObserver(
  'clinical_document.discharge_summary.signed',
  4,
);
const dischargeSummarySignedProjectorV4 = Object.freeze(async (input) => {
  const legacyObservation = await dischargeSummarySignedObserverV4(input);
  const projection = await inpatientPathwayProjectorHandler(input);
  return Object.freeze({
    ...projection,
    legacy_shadow_observed: legacyObservation.shadow_observed,
  });
});

const generationFourEntries = [
  ...PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.map((eventType) =>
    Object.freeze([
      eventType,
      eventType === 'clinical_document.discharge_summary.signed'
        ? dischargeSummarySignedProjectorV4
        : createShadowObserver(eventType, 4),
    ])),
  ...DIAGNOSTIC_PATHWAY_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, diagnosticPathwayProjectorHandler])),
  ...REFERRAL_PATHWAY_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, referralPathwayProjectorHandler])),
  ...OP_PATHWAY_EVENT_TYPES.map((eventType) =>
    Object.freeze([eventType, opPathwayProjectorHandler])),
  ...INPATIENT_PATHWAY_EVENT_TYPES
    .filter((eventType) => !PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.includes(eventType))
    .map((eventType) =>
      Object.freeze([eventType, inpatientPathwayProjectorHandler])),
];

export const pathwayProjectorRegistryV4 = buildPathwayProjectorRegistry(
  {
    generation: 4,
    entries: generationFourEntries,
  },
  { allowCanonical: true },
);

if (PATHWAY_PROJECTOR_GENERATION !== pathwayProjectorRegistryV4.generation) {
  throw new TypeError('Configured pathway projector generation has no canonical registry');
}

export const pathwayProjectorRegistry = pathwayProjectorRegistryV4;

export default pathwayProjectorRegistry;
