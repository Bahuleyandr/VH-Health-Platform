// src/routes/downtime/staticDowntimeRoutes.js
//
// DB-FREE static downtime ward-pack mirror (WS2 / REL-5 — B2.5).
//
// PURPOSE: the regular /api/v1/downtime/* surface reads downtime_snapshots via
// Prisma and is JWT + clinical-role gated — exactly useless during the
// DB/auth/network partition when downtime packs are actually needed. This
// router serves the pre-rendered, self-contained ward-pack HTML files that
// wardDowntimePackService writes to the static mirror dir (DOWNTIME_MIRROR_DIR,
// see src/config/downtimeConfig.js). Every handler reads ONLY the filesystem —
// it NEVER imports or calls prisma — so packs stay reachable with the backend's
// DB layer down.
//
// SECURITY / PHI POSTURE:
//   * Ward packs contain PHI (census, allergies, MAR, diagnoses).
//   * This endpoint is token-gated in production (mounted behind
//     requireProductionMonitoringAccess in app.js — no-op outside prod, x-
//     monitoring-token required in prod) and is intended for LAN / ops-box
//     access during an outage, mirroring the /metrics posture.
//   * It CANNOT write a DB audit row during an outage (the DB may be the thing
//     that is down), so access is recorded to the Winston file log instead —
//     never silently. Do NOT add a Prisma-backed phiAccessLogger here; that
//     would defeat the DB-free guarantee.
//   * :wardId is sanitized to a strict numeric-or-UUID token and the resolved
//     file path is verified to stay within the mirror dir (path-traversal
//     defence) — raw user input is never interpolated into a filesystem path.

import express from 'express';
import fsSync from 'fs';
import path from 'path';
import logger from '../../logging/logger.js';
import { getDowntimeMirrorDir } from '../../config/downtimeConfig.js';

const router = express.Router();

// Strict ward-id shapes: a positive integer (e.g. "12") or a UUID. Anything
// else (slashes, dots, encoded traversal, empty) is rejected before it can
// touch the filesystem.
const NUMERIC_ID = /^[0-9]{1,12}$/;
const UUID_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isSafeWardId(value) {
  return typeof value === 'string' && (NUMERIC_ID.test(value) || UUID_ID.test(value));
}

function setHtmlHeaders(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Outage data: never cache. Staff must always get the freshest mirrored pack.
  res.setHeader('Cache-Control', 'no-store');
}

// Minimal, self-contained fallback shown (HTTP 200) when a requested file is
// not in the mirror — e.g. before the first generation pass, or for a ward with
// no occupied beds. NOT a 404/500: during an outage a hard error is worse than
// a clear instruction to fall back to paper. References the printed procedure.
function fallbackHtml(detail) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Downtime pack unavailable</title>
<style>
  body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#111;max-width:720px}
  h1{font-size:20px;margin:0 0 8px} .box{background:#fff3cd;border:1px solid #d9a40e;padding:12px 16px;border-radius:6px}
  code{background:#eee;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>Downtime pack not available</h1>
<div class="box">
  <p><strong>${detail || 'The requested ward pack is not in the offline mirror.'}</strong></p>
  <p>Use the most recent <strong>printed</strong> downtime pack for this ward, and record
  all care on the <strong>paper downtime forms</strong>. Back-enter into the system once it
  has recovered.</p>
  <p>See the downtime procedure (<code>docs/DOWNTIME_PROCEDURE.md</code>) for the full steps.</p>
</div>
</body></html>`;
}

/**
 * Resolve a file inside the mirror dir, guaranteeing the result stays within
 * the dir even if `name` somehow contained traversal sequences (it can't, given
 * the upstream allowlist, but this is belt-and-braces). Returns null if the
 * resolved path escapes the mirror dir.
 */
function resolveWithinMirror(mirrorDir, name) {
  const base = path.resolve(mirrorDir);
  const resolved = path.resolve(base, name);
  // Ensure resolved is base itself or sits under base + separator.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return null;
  }
  return resolved;
}

// Record the access to the Winston file log (cannot DB-audit during an outage).
function logAccess(req, target) {
  logger.warn('Static downtime mirror accessed (DB-free PHI surface)', {
    target,
    path: req.originalUrl || req.url,
    method: req.method,
    ip: req.ip,
  });
}

// GET / — the mirror index listing the available ward packs.
router.get('/', (req, res) => {
  const mirrorDir = getDowntimeMirrorDir();
  logAccess(req, 'index');
  setHtmlHeaders(res);

  const file = resolveWithinMirror(mirrorDir, 'index.html');
  if (!file) {
    return res.status(200).send(fallbackHtml('Downtime mirror index is unavailable.'));
  }
  try {
    const html = fsSync.readFileSync(file, 'utf8');
    return res.status(200).send(html);
  } catch {
    // Missing/unreadable index → static fallback, never a hard error.
    return res.status(200).send(fallbackHtml('No ward packs have been mirrored yet.'));
  }
});

// GET /wards/:wardId — the static pack for one ward.
router.get('/wards/:wardId', (req, res) => {
  const mirrorDir = getDowntimeMirrorDir();
  const { wardId } = req.params;
  setHtmlHeaders(res);

  if (!isSafeWardId(wardId)) {
    // Reject malformed ids (incl. traversal attempts) without touching disk.
    logAccess(req, 'ward:rejected');
    return res.status(200).send(fallbackHtml('Invalid ward identifier.'));
  }

  logAccess(req, `ward:${wardId}`);
  const file = resolveWithinMirror(mirrorDir, `ward-${wardId}.html`);
  if (!file) {
    return res.status(200).send(fallbackHtml('Invalid ward identifier.'));
  }
  try {
    const html = fsSync.readFileSync(file, 'utf8');
    return res.status(200).send(html);
  } catch {
    // Missing pack for this ward → static fallback (200), point staff to paper.
    return res.status(200).send(
      fallbackHtml(`No offline pack is available for ward ${wardId}.`),
    );
  }
});

export default router;
