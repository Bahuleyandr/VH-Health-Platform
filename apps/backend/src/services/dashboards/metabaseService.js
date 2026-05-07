// src/services/dashboards/metabaseService.js
//
// Sprint 9 — signed-URL helper for embedding Metabase dashboards
// inside the admin portal. Metabase embedding flow:
//
//   1. Admin sets up an "embedded" dashboard in Metabase, gets back
//      a numeric dashboard id and public-key/private-key pair.
//   2. We hold the private key as METABASE_EMBED_SECRET env.
//   3. To embed, the backend signs a JWT containing
//        { resource: { dashboard: <id> }, params: {...}, exp }
//      with HS256 + the private key.
//   4. Front-end loads
//        <iframe src="<METABASE_URL>/embed/dashboard/<jwt>#bordered=false"></iframe>
//
// This keeps Metabase entirely server-side; the user never logs in
// to Metabase directly. params let us inject tenant/department/date
// scoping per-user without giving the user that authority in Metabase.

import jwt from 'jsonwebtoken';
import { AppError } from '../../utils/AppError.js';
import * as snapshotService from './snapshotService.js';

const METABASE_URL = process.env.METABASE_URL || '';
const METABASE_EMBED_SECRET = process.env.METABASE_EMBED_SECRET || '';

// Curated catalogue surfaced to the front-end so the dashboard picker
// isn't free-text. The numeric ids must match what's actually defined
// in the Metabase install — set via env so different tenants /
// environments can point at different dashboard ids.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const DASHBOARDS = {
  daily_ops: {
    title: 'Daily Operations Snapshot',
    description: 'Morning-huddle headline numbers: OPD, IP, OT, criticals, collections.',
    metabase_id: envInt('METABASE_DASH_DAILY_OPS', 0),
  },
  opd_volume: {
    title: 'OPD Volume',
    description: 'Per-doctor appointment counts with no-show rate.',
    metabase_id: envInt('METABASE_DASH_OPD_VOLUME', 0),
  },
  ip_occupancy: {
    title: 'IP Occupancy',
    description: 'Daily ward-level census trend.',
    metabase_id: envInt('METABASE_DASH_IP_OCCUPANCY', 0),
  },
  payer_mix: {
    title: 'Payer Mix (monthly)',
    description: 'Insurance claim revenue split + outstanding amount.',
    metabase_id: envInt('METABASE_DASH_PAYER_MIX', 0),
  },
  lab_tat: {
    title: 'Lab Turn-Around Time',
    description: 'Daily / median / p95 TAT in minutes.',
    metabase_id: envInt('METABASE_DASH_LAB_TAT', 0),
  },
  doctor_productivity: {
    title: 'Doctor Productivity (30d)',
    description: 'Rolling 30-day per-doctor appointment counts.',
    metabase_id: envInt('METABASE_DASH_DOCTOR_PROD', 0),
  },
  or_throughput: {
    title: 'OR Throughput',
    description: 'Per-room daily case counts + minutes used / scheduled.',
    metabase_id: envInt('METABASE_DASH_OR_THROUGHPUT', 0),
  },
  who_safety_compliance: {
    title: 'WHO Safety Checklist Compliance',
    description: 'Sign-in / time-out / sign-out completion rates.',
    metabase_id: envInt('METABASE_DASH_SAFETY', 0),
  },
};

export function listDashboards() {
  return Object.entries(DASHBOARDS).map(([key, d]) => ({
    key,
    title: d.title,
    description: d.description,
    available: !!d.metabase_id,
  }));
}

/**
 * Signs an embed JWT and returns the iframe URL. params let us
 * lock the dashboard down per-user (tenant id, doctor id, etc.).
 */
export function buildEmbedUrl({ key, params = {}, ttlSeconds = 600 }) {
  if (!METABASE_URL || !METABASE_EMBED_SECRET) {
    throw AppError.badRequest('Metabase embedding is not configured (METABASE_URL + METABASE_EMBED_SECRET env required)');
  }
  const dash = DASHBOARDS[key];
  if (!dash) throw AppError.notFound(`Unknown dashboard ${key}`);
  if (!dash.metabase_id) {
    throw AppError.badRequest(`Dashboard ${key} has no metabase_id configured`);
  }
  const payload = {
    resource: { dashboard: dash.metabase_id },
    params,
    exp: Math.round(Date.now() / 1000) + Math.max(60, Math.min(86400, ttlSeconds)),
  };
  const token = jwt.sign(payload, METABASE_EMBED_SECRET, { algorithm: 'HS256' });
  const url = `${METABASE_URL.replace(/\/$/, '')}/embed/dashboard/${token}#bordered=false&titled=false`;
  return { key, title: dash.title, url, ttlSeconds };
}

/**
 * Convenience for the daily-ops snapshot — the in-house BI views are
 * also queryable directly without Metabase, useful for the admin
 * portal's "today" widget without an iframe round-trip.
 */
export async function getDailyOpsSnapshot() {
  return snapshotService.getDailyOpsSnapshot();
}
