// src/routes/downtime/downtimeRoutes.js
//
// Roadmap A3 — downtime-mode ward packs. Mounted at /api/v1/downtime
// behind the clinical-staff role gate (see app.js). The HTML variant is
// what ward PCs bookmark/print; JSON serves the staff app's offline cache.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  generateWardDowntimePacks,
  listLatestWardPacks,
  getLatestWardPack,
} from '../../services/downtime/wardDowntimePackService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { body, validationResult } from 'express-validator';
import {
  issueFacilityContext,
} from '../../controllers/downtime/clinicalContinuityFacilityContextController.js';

const router = express.Router();

router.post(
  '/facility-context',
  body('facilityId').isInt({ min: 1 }),
  body('deviceProof').isObject(),
  body('deviceProof.nonce').isUUID(),
  body('deviceProof.signedAt').isISO8601({ strict: true }),
  body('deviceProof.signature').isBase64(),
  (req, res, next) => {
    const validation = validationResult(req);
    if (validation.isEmpty()) return next();
    return error(
      res,
      'Clinical continuity facility context was denied',
      HTTP_STATUS.BAD_REQUEST,
      {
        safe: true,
        topLevel: { code: 'CONTINUITY_FACILITY_CONTEXT_DENIED' },
      },
    );
  },
  issueFacilityContext,
);

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

// Latest pack metadata per ward.
router.get('/wards', async (req, res) => {
  try {
    const packs = await listLatestWardPacks({ tenantId: tenantOf(req) });
    success(res, { packs, count: packs.length }, 'Latest downtime packs per ward');
  } catch (err) {
    logger.error('Downtime pack list failed:', err);
    error(res, 'Failed to list downtime packs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// Latest pack for one ward. ?format=html returns the printable document.
router.get('/wards/:wardId/latest', async (req, res) => {
  try {
    const wardId = Number.parseInt(req.params.wardId, 10);
    if (!Number.isInteger(wardId) || wardId <= 0) {
      return error(res, 'wardId must be a positive integer', HTTP_STATUS.BAD_REQUEST);
    }
    const pack = await getLatestWardPack(wardId, { tenantId: tenantOf(req) });
    if (!pack) {
      return error(res, 'No downtime pack generated for this ward yet', HTTP_STATUS.NOT_FOUND);
    }
    if (String(req.query.format || '').toLowerCase() === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pack.payload?.html || '<p>Pack payload missing HTML rendering.</p>');
    }
    // Strip the bulky HTML when serving JSON — clients re-render natively.
    const { html: _html, ...payload } = pack.payload || {};
    return success(res, { ...pack, payload }, 'Latest downtime pack');
  } catch (err) {
    logger.error('Downtime pack fetch failed:', err);
    return error(res, 'Failed to fetch downtime pack', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// Manual regeneration (admin only) — e.g. right before planned maintenance.
router.post('/generate', async (req, res) => {
  try {
    if (!isAdmin(req.user?.role)) {
      return error(res, 'Only admins can trigger downtime pack generation', HTTP_STATUS.FORBIDDEN);
    }
    const results = await generateWardDowntimePacks({
      tenantId: tenantOf(req),
      generatedBy: req.user?.uid || null,
    });
    success(res, { generated: results, count: results.length }, 'Downtime packs regenerated');
  } catch (err) {
    logger.error('Manual downtime pack generation failed:', err);
    error(res, 'Failed to generate downtime packs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
