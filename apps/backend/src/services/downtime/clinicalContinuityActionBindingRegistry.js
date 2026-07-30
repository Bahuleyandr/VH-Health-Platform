import {
  CLINICAL_CONTINUITY_ACTION_BINDING_NONE,
  CLINICAL_CONTINUITY_ACTION_CATALOG,
  CLINICAL_CONTINUITY_ACTION_CATALOG_SCHEMA_VERSION,
  CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES,
  CLINICAL_CONTINUITY_NOTE_DRAFT_BINDING_ID
} from '../../config/clinicalContinuityActionCatalog.js';
import { saveClinicalNoteDraft } from '../../controllers/emr/clinicalNoteDraftController.js';
import {
  NURSING_NOTE_DRAFT_ACTION_SCHEMA,
  OP_NOTE_DRAFT_ACTION_SCHEMA
} from '../../validators/clinicalContinuityActionSchemas.js';

const registrations = [];

const EXPECTED_BINDINGS = Object.freeze([
  Object.freeze({
    actionId: 'emr.nursing_note.draft.store',
    bindingId: CLINICAL_CONTINUITY_NOTE_DRAFT_BINDING_ID,
    fullRoutePath: '/api/v1/emr/notes/draft',
    handler: saveClinicalNoteDraft,
    method: 'PUT',
    routePath: '/notes/draft',
    schema: NURSING_NOTE_DRAFT_ACTION_SCHEMA
  }),
  Object.freeze({
    actionId: 'emr.op_note.draft.store',
    bindingId: CLINICAL_CONTINUITY_NOTE_DRAFT_BINDING_ID,
    fullRoutePath: '/api/v1/emr/notes/draft',
    handler: saveClinicalNoteDraft,
    method: 'PUT',
    routePath: '/notes/draft',
    schema: OP_NOTE_DRAFT_ACTION_SCHEMA
  })
]);

function bindingError(actionId, message) {
  throw new Error(`Clinical continuity binding ${actionId}: ${message}`);
}

function discriminator(schema, actionId) {
  const value = schema?.['x-continuity-discriminator'];
  if (
    !value ||
    typeof value.field !== 'string' ||
    !Array.isArray(value.values) ||
    value.values.length === 0 ||
    value.values.some(item => typeof item !== 'string' || item.length === 0)
  ) {
    bindingError(actionId, 'schema is missing a closed continuity discriminator');
  }
  return {
    field: value.field,
    values: new Set(value.values)
  };
}

function cloneRegistration(value) {
  return {
    actionId: value.actionId,
    bindingId: value.bindingId,
    fullRoutePath: value.fullRoutePath,
    handler: value.handler,
    method: value.method,
    routePath: value.routePath,
    schema: value.schema
  };
}

export function registerClinicalContinuityActionRoute({
  router,
  method,
  routePath,
  fullRoutePath,
  handler,
  beforeHandlers = [],
  actions
}) {
  const normalizedMethod = String(method || '').toUpperCase();
  const mount = router?.[normalizedMethod.toLowerCase()];
  if (typeof mount !== 'function') {
    throw new Error(`Clinical continuity route method ${normalizedMethod || '<empty>'} is invalid`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`Clinical continuity route ${fullRoutePath || routePath} has no handler`);
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error(`Clinical continuity route ${fullRoutePath || routePath} has no actions`);
  }

  for (const action of actions) {
    registrations.push({
      actionId: action.actionId,
      bindingId: action.bindingId,
      fullRoutePath,
      handler,
      method: normalizedMethod,
      routePath,
      schema: action.schema
    });
  }

  mount.call(router, routePath, ...beforeHandlers, handler);
}

export function assertClinicalContinuityActionBindings({
  catalogue = CLINICAL_CONTINUITY_ACTION_CATALOG,
  expectedBindings = EXPECTED_BINDINGS,
  mountedBindings = registrations
} = {}) {
  if (CLINICAL_CONTINUITY_ACTION_CATALOG_SCHEMA_VERSION !== 1) {
    throw new Error(
      `Clinical continuity binding catalogue: unsupported catalogue schema ${CLINICAL_CONTINUITY_ACTION_CATALOG_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw new Error('Clinical continuity binding catalogue: no approved actions');
  }

  const catalogueById = new Map();
  for (const action of catalogue) {
    const actionId = String(action?.actionId || '<missing>');
    if (catalogueById.has(actionId)) bindingError(actionId, 'duplicate approved action ID');
    catalogueById.set(actionId, action);
  }

  const expectedById = new Map();
  for (const expected of expectedBindings) {
    if (expectedById.has(expected.actionId)) {
      bindingError(expected.actionId, 'duplicate expected executable binding');
    }
    expectedById.set(expected.actionId, expected);
  }

  const mountedById = new Map();
  for (const mounted of mountedBindings) {
    const actionId = String(mounted?.actionId || '<missing>');
    if (mountedById.has(actionId)) bindingError(actionId, 'duplicate mounted executable binding');
    mountedById.set(actionId, mounted);
    const action = catalogueById.get(actionId);
    if (!action) bindingError(actionId, 'mounted action is not in the approved catalogue');
    if (action.replayEndpoint?.bindingId === CLINICAL_CONTINUITY_ACTION_BINDING_NONE) {
      bindingError(actionId, 'unexpected executable action for a default-deny catalogue entry');
    }
  }

  for (const action of catalogue) {
    const actionId = action.actionId;
    const bindingId = action.replayEndpoint?.bindingId;
    const shouldExecute = bindingId !== CLINICAL_CONTINUITY_ACTION_BINDING_NONE;
    const expected = expectedById.get(actionId);
    const mounted = mountedById.get(actionId);

    if (!shouldExecute) {
      if (expected || mounted) {
        bindingError(actionId, 'default-deny action has an executable binding');
      }
      continue;
    }
    if (!expected) bindingError(actionId, 'missing expected executable binding');
    if (!mounted) bindingError(actionId, 'missing mounted executable binding');
    if (expected.bindingId !== bindingId || mounted.bindingId !== bindingId) {
      bindingError(actionId, `binding ID mismatch for ${bindingId}`);
    }
    if (mounted.method !== expected.method) {
      bindingError(actionId, `method mismatch: expected ${expected.method}, got ${mounted.method}`);
    }
    if (
      mounted.routePath !== expected.routePath ||
      mounted.fullRoutePath !== expected.fullRoutePath
    ) {
      bindingError(actionId, 'route path mismatch');
    }
    if (mounted.handler !== expected.handler) bindingError(actionId, 'handler reference mismatch');
    if (mounted.schema !== expected.schema) bindingError(actionId, 'schema reference mismatch');
  }

  for (const expected of expectedBindings) {
    if (!catalogueById.has(expected.actionId)) {
      bindingError(expected.actionId, 'expected binding is not in the approved catalogue');
    }
  }

  const routeGroups = new Map();
  for (const binding of mountedBindings) {
    const routeKey = `${binding.method} ${binding.fullRoutePath}`;
    const grouped = routeGroups.get(routeKey) || [];
    grouped.push(binding);
    routeGroups.set(routeKey, grouped);
  }
  for (const bindings of routeGroups.values()) {
    for (let leftIndex = 0; leftIndex < bindings.length; leftIndex += 1) {
      const left = bindings[leftIndex];
      const leftDiscriminator = discriminator(left.schema, left.actionId);
      for (let rightIndex = leftIndex + 1; rightIndex < bindings.length; rightIndex += 1) {
        const right = bindings[rightIndex];
        const rightDiscriminator = discriminator(right.schema, right.actionId);
        if (leftDiscriminator.field !== rightDiscriminator.field) {
          bindingError(
            right.actionId,
            `non-disjoint discriminator field shared with ${left.actionId}`
          );
        }
        const overlap = [...leftDiscriminator.values].filter(value =>
          rightDiscriminator.values.has(value)
        );
        if (overlap.length > 0) {
          bindingError(
            right.actionId,
            `non-disjoint discriminator shared with ${left.actionId}: ${overlap.join(', ')}`
          );
        }
      }
    }
  }

  return Object.freeze({
    approvedActionCount: catalogue.length,
    executableBindingCount: mountedBindings.length
  });
}

export function resolveClinicalContinuityActionBinding({ actionId, method, path }) {
  return (
    registrations.find(
      registration =>
        registration.actionId === actionId &&
        registration.method === String(method || '').toUpperCase() &&
        registration.fullRoutePath === path
    ) || null
  );
}

function routePatternMatches(routePattern, path) {
  const expected = String(routePattern || '').split('/').filter(Boolean);
  const actual = String(path || '').split('/').filter(Boolean);
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) => segment.startsWith(':') || segment === actual[index]
    )
  );
}

export function resolveClinicalContinuityRouteTemplate({ actionId, method, path }) {
  const binding = resolveClinicalContinuityActionBinding({ actionId, method, path });
  if (binding) return binding.fullRoutePath;
  const normalizedMethod = String(method || '').toUpperCase();
  const alias = CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES.find(
    candidate =>
      candidate.method === normalizedMethod &&
      candidate.actionIds.includes(actionId) &&
      routePatternMatches(candidate.routePattern, path)
  );
  return alias?.routePattern || 'unmatched';
}

export const __testing__ = Object.freeze({
  expectedBindings: EXPECTED_BINDINGS.map(cloneRegistration),
  mountedBindings: registrations
});
