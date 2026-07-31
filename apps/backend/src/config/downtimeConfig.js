// src/config/downtimeConfig.js
//
// Configuration for the static, DB-free downtime mirror (WS2 / REL-5 — B2.5).
//
// During a DB/auth/network partition the regular /api/v1/downtime/* surface is
// useless: it reads downtime_snapshots via Prisma and is JWT + clinical-role
// gated. The static mirror is a plain directory of pre-rendered, self-contained
// ward-pack HTML files that wardDowntimePackService writes on every successful
// generation pass and the DB-free static route serves straight off disk.
//
// The directory is resolved from DOWNTIME_MIRROR_DIR. It has a safe default
// (under the OS temp dir) so a missing env var never crashes the app — it is
// registered as a warn-tier optional in validateEnv.js alongside R2_* /
// SENTRY_DSN. In production the operator points DOWNTIME_MIRROR_DIR at a shared
// hostPath/Longhorn volume that both the backend Deployment and the
// ward-downtime-packs CronJob mount, and an ops-box syncs it to the LAN share
// (see docs/DOWNTIME_PROCEDURE.md).

import os from 'os';
import path from 'path';

// Subdirectory name under the OS temp dir used for the dev/test default. Kept
// vendor-prefixed so it can't collide with another tool's temp artifacts.
export const DEFAULT_MIRROR_SUBDIR = 'vhhealth-downtime-mirror';
export const CLINICAL_CONTINUITY_PACKS_FLAG = 'CLINICAL_CONTINUITY_PACKS_ENABLED';
export const CLINICAL_CONTINUITY_ACTION_REGISTRY_FLAG =
  'CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED';

/**
 * Resolve the directory the downtime mirror reads from / writes to.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string} absolute directory path.
 *   - DOWNTIME_MIRROR_DIR when set (trimmed),
 *   - else <os.tmpdir()>/vhhealth-downtime-mirror (cross-platform default so the
 *     tests work on Windows and Linux without configuration).
 */
export function getDowntimeMirrorDir(env = process.env) {
  const configured = typeof env.DOWNTIME_MIRROR_DIR === 'string'
    ? env.DOWNTIME_MIRROR_DIR.trim()
    : '';
  if (configured) return configured;
  return path.join(os.tmpdir(), DEFAULT_MIRROR_SUBDIR);
}

export function clinicalContinuityPacksEnabled(env = process.env) {
  return String(env[CLINICAL_CONTINUITY_PACKS_FLAG] || '').trim().toLowerCase() === 'true';
}

export function clinicalContinuityActionRegistryEnabled(env = process.env) {
  return (
    String(env[CLINICAL_CONTINUITY_ACTION_REGISTRY_FLAG] || '').trim().toLowerCase() === 'true'
  );
}

/**
 * C3 pack-set publication never falls back to the OS temp directory. The
 * operator-owned durable volume is provisioned outside C3.1; until both the
 * feature flag and explicit root exist, the writer remains inert.
 */
export function getClinicalContinuityPublicationRoot(env = process.env) {
  if (!clinicalContinuityPacksEnabled(env)) return null;
  const configured = typeof env.DOWNTIME_MIRROR_DIR === 'string'
    ? env.DOWNTIME_MIRROR_DIR.trim()
    : '';
  if (!configured) {
    throw new Error(
      'DOWNTIME_MIRROR_DIR is required when CLINICAL_CONTINUITY_PACKS_ENABLED=true',
    );
  }
  return configured;
}

export default {
  getDowntimeMirrorDir,
  getClinicalContinuityPublicationRoot,
  clinicalContinuityActionRegistryEnabled,
  clinicalContinuityPacksEnabled,
  DEFAULT_MIRROR_SUBDIR,
  CLINICAL_CONTINUITY_ACTION_REGISTRY_FLAG,
  CLINICAL_CONTINUITY_PACKS_FLAG,
};
