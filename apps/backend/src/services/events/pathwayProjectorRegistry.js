export const PATHWAY_PROJECTOR_CONSUMER_KEY = 'care_pathway_projector';
export const PATHWAY_PROJECTOR_GENERATION = 1;

export const PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES = Object.freeze([
  'clinical.handover.created',
  'clinical.handover.acknowledged',
  'clinical.prehospital_handover.created',
  'clinical.prehospital_handover.accepted',
  'clinical_document.discharge_summary.saved',
  'clinical_document.discharge_summary.signed',
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
  if (generation !== PATHWAY_PROJECTOR_GENERATION) return;

  const hasExactGenerationOneMembership =
    handlers.size === PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.length
    && PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.every((eventType) => handlers.has(eventType));
  if (!hasExactGenerationOneMembership) {
    throw new TypeError('Pathway projector generation 1 must contain exactly its frozen event types');
  }
}

/**
 * Build a generation-scoped, immutable exact-match handler registry.
 *
 * Entries are `[eventType, handler]` tuples. Construction copies every tuple
 * before retaining it, and the resolver is the registry's only lookup surface;
 * callers cannot add, replace, or remove handlers after construction.
 */
function buildPathwayProjectorRegistry({ generation, entries }, { allowGenerationOne = false } = {}) {
  const normalizedGeneration = requireGeneration(generation);
  if (normalizedGeneration === PATHWAY_PROJECTOR_GENERATION && !allowGenerationOne) {
    throw new TypeError('Pathway projector generation 1 is reserved for the canonical registry');
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

function createGenerationOneShadowObserver(eventType) {
  const observer = async function observeGenerationOneEvent() {
    return Object.freeze({
      consumer_key: PATHWAY_PROJECTOR_CONSUMER_KEY,
      generation: PATHWAY_PROJECTOR_GENERATION,
      event_type: eventType,
      shadow_observed: true,
    });
  };
  return Object.freeze(observer);
}

const generationOneEntries = PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES.map((eventType) =>
  Object.freeze([eventType, createGenerationOneShadowObserver(eventType)]));

export const pathwayProjectorRegistry = buildPathwayProjectorRegistry(
  {
    generation: PATHWAY_PROJECTOR_GENERATION,
    entries: generationOneEntries,
  },
  { allowGenerationOne: true },
);

export default pathwayProjectorRegistry;
