// apps/backend/src/services/clinical/cathParamGuards.js
//
// The parameter guards the three pre-procedure lab readiness modules share.
//
// Every raw parameter that reaches a statement in those modules is bound and
// cast; nothing is interpolated. These are what decide whether a value may be
// bound at all, and they are deliberately STRICTER than the JS coercions they
// replace: positiveInt refuses '12abc', ' 12 ' and '1e3', which Number() turns
// into 12, 12 and 1000 and which would then be bound to a ::bigint the caller
// never wrote.
//
// They live here rather than in one of the three because all three need them
// and the alternative — a copy per module — is three places for the strictness
// above to drift. Plan 1's and Plan 2's cath services (cathDeviceReuseService,
// bloodborneMarkerService, cathLabService) still carry their own near-identical
// copies; consolidating those is a separate change with its own blast radius,
// deliberately not folded into a behaviour-preserving split.

import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const tenantOr = (value) => requireTenantId(value);

export function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  }
  return text.toLowerCase();
}

// `max` is the THIRD POSITIONAL argument here. The near-identical copy in the
// device-reuse service takes its bound as an options object (`{ max }`), and
// the two sit one import away from each other — so a caller that reaches for
// the wrong shape passes an object where a number is expected. `n > {max: 40}`
// is false for every n, which silently drops the bound rather than tightening
// it: the guard would keep answering "valid" for values it was called to
// refuse. That is a programming error in OUR code, not bad input from a
// client, so it throws TypeError (a crash the tests and the logs name) rather
// than AppError.badRequest (a 400 the caller would read as the user's fault).
export function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(max)) {
    throw new TypeError(
      `positiveInt(${label}) max must be a finite number, got ${typeof max}`,
    );
  }
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  return n;
}

export function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

export function num(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  return value;
}

export function withTenant(tenantId, db, fn) {
  return db ? fn(db) : setTenant(tenantId, fn);
}
