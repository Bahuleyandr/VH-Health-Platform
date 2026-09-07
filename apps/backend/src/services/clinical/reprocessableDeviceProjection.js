import {
  projectReuseRestrictionForRole as projectCathReuseRestrictionForRole,
  roleSeesSerologyDetail,
} from './cathDeviceReuseService.js';

const OPERATIONAL_HOLD_KEYS = Object.freeze([
  'id',
  'device_id',
  'operational_type',
  'reason_code',
  'status',
  'pending_return',
  'processing_required',
  'created_at',
]);

function safeScreen(screen, role) {
  if (!screen || typeof screen !== 'object') return screen;
  if (roleSeesSerologyDetail(role)) return screen;
  const sanitized = { ...screen, reasons: [] };
  delete sanitized.markers;
  if (Object.hasOwn(sanitized, 'isolation_class')) sanitized.isolation_class = null;
  return sanitized;
}

export function projectUsageForRole(usage, role) {
  if (!usage) return usage;
  const projected = {
    ...usage,
    reuse_screen: safeScreen(usage.reuse_screen, role),
    post_use_screen: safeScreen(usage.post_use_screen, role),
  };
  if (!roleSeesSerologyDetail(role)) {
    delete projected.patient_uid;
    delete projected.metadata;
  }
  return projected;
}

export function projectReuseRestrictionForRole(restriction, role) {
  if (!restriction) return restriction;
  if (Object.hasOwn(restriction, 'asOf')) {
    if (roleSeesSerologyDetail(role)) return restriction;
    const projected = { ...restriction, reasons: [] };
    delete projected.markers;
    if (Object.hasOwn(projected, 'isolation_class')) projected.isolation_class = null;
    return projected;
  }
  return projectCathReuseRestrictionForRole(restriction, role);
}

export function projectHoldForOperationalRole(hold) {
  if (!hold) return hold;
  return Object.fromEntries(OPERATIONAL_HOLD_KEYS
    .filter((key) => Object.hasOwn(hold, key))
    .map((key) => [key, hold[key]]));
}

export function projectDeviceHistoryForOperationalRole(history, role) {
  return {
    device: history.device,
    usages: (history.usages ?? []).map((usage) => projectUsageForRole(usage, role)),
    holds: (history.holds ?? []).map(projectHoldForOperationalRole),
    events: (history.events ?? []).map((event) => ({
      id: event.id,
      device_id: event.device_id,
      kind: event.kind,
      cycle_type: event.cycle_type,
      initial_outcome: event.initial_outcome,
      recorded_at: event.recorded_at,
    })),
  };
}

export const _internal = Object.freeze({ OPERATIONAL_HOLD_KEYS, safeScreen });
