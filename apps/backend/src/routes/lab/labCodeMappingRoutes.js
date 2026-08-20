// src/routes/lab/labCodeMappingRoutes.js
//
// Terminology slate C1 / WP3 — curated analyzer/interface code → catalog/
// LOINC mappings (migration 721). Mounted at /api/v1/lab/code-mappings from
// routes/lab/labRoutes.js, so the app-level LAB route gate applies first;
// reads are then open to staff/admin and writes are limited to the same
// catalog-curator roles the terminology binding surface uses.
//
// The mapping rows only ever take effect on ingest when the
// LAB_LOINC_MAPPING_ENABLED env kill switch AND the tenant
// settings.labLoincMapping.enabled flag are both on — curating rows here is
// always safe and never changes ingest behavior by itself.

import { Router } from 'express';
import * as labCodeMapping from '../../services/lab/labCodeMappingService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { TERMINOLOGY_CURATOR_ROLES } from '../terminology/terminologyRoutes.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Lab code mapping error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  return next();
}

// Same curator population as terminology binding writes (terminologyRoutes).
function requireCurator(req, res, next) {
  const role = req.user?.role;
  if (!isAdmin(role) && !TERMINOLOGY_CURATOR_ROLES.includes(role)) {
    return error(res, 'Only catalog curators can modify lab code mappings', 403);
  }
  return next();
}

// Coverage before /:id so the literal path cannot be captured as an id.
router.get('/coverage', requireStaffOrAdmin, wrap(async (req) =>
  labCodeMapping.coverageReport({
    tenantId: tenantOf(req),
    days: req.query.days,
  })));

router.get('/', requireStaffOrAdmin, wrap(async (req) =>
  labCodeMapping.listMappings({
    tenantId: tenantOf(req),
    sourceKey: req.query.source_key,
    q: req.query.q,
    includeInactive: String(req.query.include_inactive || '').toLowerCase() === 'true',
    limit: req.query.limit,
    offset: req.query.offset,
  })));

router.get('/:id', requireStaffOrAdmin, wrap(async (req) =>
  labCodeMapping.getMapping({
    tenantId: tenantOf(req),
    id: req.params.id,
  })));

router.post('/', requireCurator, wrap(async (req) =>
  labCodeMapping.createMapping({
    tenantId: tenantOf(req),
    actorUid: req.user?.uid || null,
    mapping: req.body || {},
  })));

router.put('/:id', requireCurator, wrap(async (req) =>
  labCodeMapping.updateMapping({
    tenantId: tenantOf(req),
    id: req.params.id,
    actorUid: req.user?.uid || null,
    patch: req.body || {},
  })));

// DELETE deactivates (audit-preserving soft delete) — the live-unique index
// frees the (tenant, source, code) slot for a corrected replacement row.
router.delete('/:id', requireCurator, wrap(async (req) =>
  labCodeMapping.deactivateMapping({
    tenantId: tenantOf(req),
    id: req.params.id,
    actorUid: req.user?.uid || null,
  })));

export default router;
