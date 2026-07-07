// src/routes/terminology/terminologyRoutes.js
//
// Roadmap B8 — central terminology service. Mounted at /api/v1/terminology
// behind the clinical-staff role gate (see app.js). Read surfaces (search,
// validate, map, coverage) serve every clinical client; binding writes are
// limited to catalog curators (admin, pharmacy, lab, medical records,
// quality) below.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  listCodeSystems,
  searchConcepts,
  getConcept,
  validateCode,
  mapCode,
  upsertConceptMap,
  bindCatalogItem,
  listCatalogBindings,
  suggestCatalogBindings,
  coverageReport,
} from '../../services/terminology/terminologyService.js';
import {
  getTenantTerminologySettings,
  setTenantTerminologySettings,
} from '../../services/terminology/terminologySettingsService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin } from '../../utils/roleHelpers.js';

const router = express.Router();

// Catalog curation: who may write bindings/maps. Same shape as the
// PATHOLOGIST_SIGN_ROLES convention in roleHelpers (named constant, no
// inline arrays at call sites). LAB_INCHARGE / LAB_TECHNICIAN /
// PATHOLOGIST exist as live role strings (see PATHOLOGIST_SIGN_ROLES)
// without ROLES entries.
export const TERMINOLOGY_CURATOR_ROLES = [
  ROLES.ADMIN,
  'SUPER_ADMIN',
  ROLES.PHARMACY_INCHARGE,
  ROLES.PHARMACY_STAFF,
  ROLES.LAB_STAFF,
  'LAB_INCHARGE',
  'LAB_TECHNICIAN',
  'PATHOLOGIST',
  ROLES.MEDICAL_RECORDS,
  ROLES.QUALITY_OFFICER,
];

const isCurator = (role) => isAdmin(role) || TERMINOLOGY_CURATOR_ROLES.includes(role);

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Terminology ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/code-systems', async (req, res) => {
  try {
    const systems = await listCodeSystems();
    return success(res, { systems, count: systems.length }, 'Registered code systems');
  } catch (err) {
    return handleFailure(res, err, 'list code systems');
  }
});

// GET /settings - tenant-scoped UI preferences; defaults are inert.
router.get('/settings', async (req, res) => {
  try {
    const settings = await getTenantTerminologySettings(req.tenantId || req.user?.tenant_id || req.user?.tenantId);
    return success(res, { settings }, 'Tenant terminology settings');
  } catch (err) {
    return handleFailure(res, err, 'fetch terminology settings');
  }
});

// PUT /settings - operator/curator-maintained tenant preference row.
router.put('/settings', async (req, res) => {
  try {
    if (!isCurator(req.user?.role)) {
      return error(res, 'Only catalog curators can update terminology settings', HTTP_STATUS.FORBIDDEN);
    }
    const settings = await setTenantTerminologySettings(
      req.tenantId || req.user?.tenant_id || req.user?.tenantId,
      {
        preferred_diagnosis_system: req.body.preferred_diagnosis_system,
        enabled_systems: req.body.enabled_systems,
        snomed_pickers_enabled: req.body.snomed_pickers_enabled,
      },
      { actorUid: req.user?.uid || null },
    );
    return success(res, { settings }, 'Tenant terminology settings updated');
  } catch (err) {
    return handleFailure(res, err, 'update terminology settings');
  }
});

// GET /search?system=ICD10&q=fever&limit=20
router.get('/search', async (req, res) => {
  try {
    const concepts = await searchConcepts({
      system: req.query.system,
      q: req.query.q,
      limit: req.query.limit,
      tenantId: req.tenantId || req.user?.tenant_id || req.user?.tenantId,
    });
    return success(res, { concepts, count: concepts.length }, 'Concept search results');
  } catch (err) {
    return handleFailure(res, err, 'search concepts');
  }
});

// GET /concepts/:system/:code — exact lookup
router.get('/concepts/:system/:code', async (req, res) => {
  try {
    const concept = await getConcept(req.params.system, req.params.code);
    if (!concept) {
      return error(res, 'Concept not found', HTTP_STATUS.NOT_FOUND);
    }
    return success(res, { concept }, 'Concept');
  } catch (err) {
    return handleFailure(res, err, 'fetch concept');
  }
});

// GET /validate?system=LOINC&code=2160-0
router.get('/validate', async (req, res) => {
  try {
    const verdict = await validateCode(req.query.system, req.query.code);
    return success(res, verdict, 'Code validation verdict');
  } catch (err) {
    return handleFailure(res, err, 'validate code');
  }
});

// GET /map?from=ICD10&code=E11.9&to=SNOMED_CT
router.get('/map', async (req, res) => {
  try {
    const result = await mapCode({
      fromSystem: req.query.from,
      code: req.query.code,
      toSystem: req.query.to,
    });
    return success(res, result, 'Concept mappings');
  } catch (err) {
    return handleFailure(res, err, 'map code');
  }
});

// POST /map — curator-maintained cross-system mapping
router.post('/map', async (req, res) => {
  try {
    if (!isCurator(req.user?.role)) {
      return error(res, 'Only catalog curators can write concept maps', HTTP_STATUS.FORBIDDEN);
    }
    const mapping = await upsertConceptMap({
      fromSystem: req.body.from_system,
      fromCode: req.body.from_code,
      toSystem: req.body.to_system,
      toCode: req.body.to_code,
      relationship: req.body.relationship || 'equivalent',
      context: req.body.context || null,
      createdBy: req.user?.uid || null,
    });
    return success(res, { mapping }, 'Concept map saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save concept map');
  }
});

// GET /bindings/:catalogType/:catalogId
router.get('/bindings/:catalogType/:catalogId', async (req, res) => {
  try {
    const bindings = await listCatalogBindings({
      catalogType: req.params.catalogType,
      catalogId: req.params.catalogId,
    });
    return success(res, { bindings, count: bindings.length }, 'Catalog bindings');
  } catch (err) {
    return handleFailure(res, err, 'list catalog bindings');
  }
});

// POST /bindings — bind one local catalog row to a standard code
router.post('/bindings', async (req, res) => {
  try {
    if (!isCurator(req.user?.role)) {
      return error(res, 'Only catalog curators can write bindings', HTTP_STATUS.FORBIDDEN);
    }
    const binding = await bindCatalogItem({
      catalogType: req.body.catalog_type,
      catalogId: req.body.catalog_id,
      system: req.body.system,
      code: req.body.code,
      display: req.body.display || null,
      bindingStatus: req.body.binding_status || 'confirmed',
      confidence: req.body.confidence ?? null,
      boundBy: req.user?.uid || null,
      allowUnknownCode: req.body.allow_unknown_code === true,
    });
    return success(res, { binding }, 'Catalog binding saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'save catalog binding');
  }
});

// POST /bindings/suggest — name-match suggestions; persist=true writes
// binding_status='suggested' rows for curator review.
router.post('/bindings/suggest', async (req, res) => {
  try {
    if (!isCurator(req.user?.role)) {
      return error(res, 'Only catalog curators can run binding suggestions', HTTP_STATUS.FORBIDDEN);
    }
    const suggestions = await suggestCatalogBindings({
      catalogType: req.body.catalog_type,
      system: req.body.system || null,
      limit: req.body.limit,
      persist: req.body.persist === true,
      boundBy: req.user?.uid || null,
    });
    return success(res, { suggestions, count: suggestions.length }, 'Binding suggestions');
  } catch (err) {
    return handleFailure(res, err, 'suggest catalog bindings');
  }
});

// GET /coverage — confirmed-binding coverage per catalog (B8 exit metric)
router.get('/coverage', async (req, res) => {
  try {
    const coverage = await coverageReport();
    return success(res, { coverage }, 'Terminology binding coverage');
  } catch (err) {
    return handleFailure(res, err, 'compute terminology coverage');
  }
});

export default router;
