// Terminology C1 / WP2 — diagnosis-coding enforcement on downstream documents.
//
// One shared gate for the document surfaces that persist free-text ICD-10
// codes today: death certificates, insurance pre-auth, insurance claims
// (PM-JAY cases), and discharge summaries. Effective level is the AND (min)
// of the env kill-switch TERMINOLOGY_CODING_ENFORCEMENT and the tenant's
// per-surface tenant_terminology_settings.coding_enforcement[surface]
// (migration 720) — both default 'off', so with nothing flipped every
// surface behaves byte-identically to before this service existed.
//
//   off   — no-op (never touches the catalogue).
//   warn  — validate supplied codes, attach warnings + terminology audit row.
//   block — invalid codes throw AppError 400 TERMINOLOGY_CODE_INVALID. The
//           caller MUST run this BEFORE any write so the canonical-timeline
//           single-transaction invariant holds (no partial writes).
//
// Blocking only ever fires on an authoritative catalogue verdict
// (validateCode mode 'catalog' — which itself requires a COMPLETED import
// batch for the system, see BC-M2). A system with no or only partial
// imported content ('unimported' / 'partial' / structural fallback) can
// only warn — content presence is part of the dark-ship gate, so an
// un-imported or partially imported deployment cannot lock up document
// flows even with both switches thrown.
//
// Absent codes are not blocked either: these document fields are optional
// today, and this gate is a validity gate, not a completeness gate.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  getTenantTerminologySettings,
  CODING_ENFORCEMENT_SURFACES,
  normalizeCodingEnforcementLevel,
} from './terminologySettingsService.js';

// terminologyService is imported lazily (only once a non-off level actually
// needs a catalogue verdict): its static graph imports prismaReadOnly, and
// pulling that into every document-service consumer would break existing
// partial lib/prisma.js jest mocks (PR #875 stale-ESM-mock lesson).

const LEVEL_RANK = Object.freeze({ off: 0, warn: 1, block: 2 });

function assertSurface(surface) {
  if (!CODING_ENFORCEMENT_SURFACES.includes(surface)) {
    throw new Error(
      `Unknown coding enforcement surface '${surface}' (expected one of ${CODING_ENFORCEMENT_SURFACES.join(', ')})`,
    );
  }
}

export function envEnforcementLevel(env = process.env) {
  return normalizeCodingEnforcementLevel(env.TERMINOLOGY_CODING_ENFORCEMENT);
}

/**
 * Effective enforcement level for one tenant + surface: min(env, tenant).
 * env off ⇒ off everywhere (kill switch); env warn caps tenant block at warn.
 */
export async function resolveEnforcementLevel({ tenantId, surface } = {}) {
  assertSurface(surface);
  const envLevel = envEnforcementLevel();
  if (envLevel === 'off') return 'off';
  const settings = await getTenantTerminologySettings(tenantId);
  const tenantLevel = normalizeCodingEnforcementLevel(
    settings?.coding_enforcement?.[surface],
  );
  return LEVEL_RANK[tenantLevel] <= LEVEL_RANK[envLevel] ? tenantLevel : envLevel;
}

function normalizeCodes(codes) {
  const flat = Array.isArray(codes) ? codes.flat() : [codes];
  const out = [];
  const seen = new Set();
  for (const item of flat) {
    if (item == null) continue;
    const text = String(item).trim();
    if (!text) continue;
    const key = text.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function recordEnforcementAudit({
  db, tenantId, surface, systemKey, level, blocked, invalid, actorUid,
}) {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO terminology_audit_events (system_key, action, summary, actor_uid, payload)
       VALUES ($1, $2, $3, $4::uuid, $5::jsonb)`,
      systemKey,
      blocked ? 'CODING_ENFORCEMENT_BLOCKED' : 'CODING_ENFORCEMENT_WARNING',
      `${blocked ? 'Blocked' : 'Warned on'} ${invalid.length} invalid ${systemKey} code(s) on ${surface}`,
      actorUid || null,
      JSON.stringify({
        tenant_id: tenantId ? String(tenantId) : null,
        surface,
        level,
        invalid_codes: invalid.map((r) => ({ code: r.code, reason: r.reason })),
      }),
    );
  } catch (err) {
    // Audit is evidence, not a gate — never fail the document write on it.
    logger.warn(`codingEnforcement audit write failed for ${surface}: ${err.message}`);
  }
}

/**
 * Validate the codes supplied on a downstream document surface.
 *
 * Returns { level, checked, valid, results, warnings }. Throws AppError 400
 * (TERMINOLOGY_CODE_INVALID) when the effective level is 'block' and at
 * least one code fails an authoritative catalogue check. Callers must invoke
 * this BEFORE any persistence so a block leaves no partial write behind.
 */
export async function validateDocumentCodes({
  tenantId,
  surface,
  systemKey = 'ICD10',
  codes = [],
  actorUid = null,
  db = prisma,
} = {}) {
  assertSurface(surface);
  const normalized = normalizeCodes(codes);
  const level = await resolveEnforcementLevel({ tenantId, surface });
  if (level === 'off' || normalized.length === 0) {
    return { level, checked: false, valid: true, results: [], warnings: [] };
  }

  const { validateCode } = await import('./terminologyService.js');
  const results = [];
  try {
    for (const code of normalized) {
      const verdict = await validateCode(systemKey, code);
      results.push({
        code,
        valid: verdict.valid === true,
        mode: verdict.mode,
        reason: verdict.reason || null,
        display: verdict.concept?.display || null,
      });
    }
  } catch (err) {
    // 'warn' promises "attach warnings, never fail the write" — a
    // terminology DB fault must degrade to unchecked, not 500 the death
    // certificate (BC-L4-adjacent house rule / reaudit BC-L2). 'block' is
    // a compliance gate and stays fail-closed: the error propagates.
    if (level === 'block') throw err;
    logger.warn(
      `codingEnforcement validation unavailable for ${surface} (level ${level}); degrading to unchecked: ${err.message}`,
    );
    const invalid = results.filter((r) => !r.valid);
    const warnings = invalid.map(
      (r) => `${systemKey} code '${r.code}' failed validation (${r.reason || 'invalid'})`,
    );
    if (invalid.length > 0) {
      await recordEnforcementAudit({
        db, tenantId, surface, systemKey, level, blocked: false, invalid, actorUid,
      });
    }
    return {
      level,
      checked: false,
      valid: invalid.length === 0,
      results,
      warnings: [
        ...warnings,
        `${systemKey} code validation unavailable (terminology lookup failed)`,
      ],
    };
  }

  const invalid = results.filter((r) => !r.valid);
  // Only an authoritative catalogue miss may block; un-imported systems
  // (mode 'unimported' / structural fallback) can never lock a document flow.
  const hardInvalid = invalid.filter((r) => r.mode === 'catalog');
  const warnings = invalid.map(
    (r) => `${systemKey} code '${r.code}' failed validation (${r.reason || 'invalid'})`,
  );

  if (invalid.length > 0) {
    const blocked = level === 'block' && hardInvalid.length > 0;
    await recordEnforcementAudit({
      db, tenantId, surface, systemKey, level, blocked, invalid, actorUid,
    });
    if (blocked) {
      throw AppError.badRequest(
        `Invalid ${systemKey} code(s) on ${surface}: ${hardInvalid.map((r) => r.code).join(', ')}`,
        'TERMINOLOGY_CODE_INVALID',
        {
          surface,
          system_key: systemKey,
          invalid_codes: hardInvalid.map((r) => ({ code: r.code, reason: r.reason })),
        },
      );
    }
  }

  return {
    level,
    checked: true,
    valid: invalid.length === 0,
    results,
    warnings,
  };
}

export default {
  envEnforcementLevel,
  resolveEnforcementLevel,
  validateDocumentCodes,
};
