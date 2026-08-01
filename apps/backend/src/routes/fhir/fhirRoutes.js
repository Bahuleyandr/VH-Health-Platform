// src/routes/fhir/fhirRoutes.js
// HL7 FHIR R4 interoperability routes
// Exposes VH Health data as FHIR-compliant JSON resources

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  toFhirPatient,
  toFhirAppointment,
  toFhirObservation,
  toFhirMedicationRequest,
  toFhirCondition,
  toFhirConditionFromProblem,
  toFhirProcedure,
  toFhirDiagnosticReport,
  toFhirAllergyIntolerance,
  toFhirEncounter,
  toFhirDocumentReference,
  toFhirServiceRequest,
} from '../../services/fhir/fhirAdapter.js';
import { validatedFhirJson, validateResource } from '../../services/fhir/fhirValidator.js';
import { requireConsent } from '../../middleware/consentMiddleware.js';
import { fhirPatientUidFromRequest } from '../../middleware/fhirPatientContext.js';
import { fhirObservationToVitals } from '../../services/fhir/observationVitalsMapper.js';
import { recordVitals } from '../../services/emr/vitalsChartService.js';
import { createProblem } from '../../services/clinical/problemListService.js';
import {
  attachResourceCodings,
  normalizeClinicalCodings,
} from '../../services/terminology/clinicalCodeBindingService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import {
  authorizePatientAccessRequest,
  patientAccessErrorPayload,
} from '../../services/security/accessDecisionService.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isDoctor, isMedicalRecords } from '../../utils/roleHelpers.js';
import {
  SMART_FHIR_WRITE_RESOURCE_PLAN,
  verifyAccessToken as verifySmartAccessToken,
  scopesAllow as smartScopesAllow,
} from '../../services/smartFhir/smartOAuthService.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Audit §3 finding #3 — consent gate on the one true EXPORT surface in this
// router: GET /Patient/:id/$everything ships a patient's entire longitudinal
// record in a single bundle to an (often third-party / interop) consumer. That
// is a disclosure-export, so it requires an active `data_sharing` consent — the
// same gate the C-CDA / FHIR-bundle exports in documentRoutes.js carry (those
// app.js mounts are reported separately). The single-resource reads/searches are
// care-team-governed and intentionally NOT consent-gated. We feed the gate FHIR's
// own /Patient/<uuid> addressing via fhirPatientUidFromRequest, and render denials
// as a FHIR OperationOutcome so the router's error contract stays consistent.
const requireFhirExportConsent = requireConsent('data_sharing', {
  resolvePatientUid: fhirPatientUidFromRequest,
  errorResponder: (res, { status, code, message }) => {
    res.status(status).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: status === 403 ? 'forbidden' : status === 400 ? 'invalid' : 'exception',
        diagnostics: message,
        details: code ? { text: code } : undefined,
      }],
    });
  },
});

function tenantOf(req) {
  const tenantId = resolveTenantOrThrow(req);
  const normalized = String(tenantId || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw AppError.forbidden('FHIR tenant context is required', 'FHIR_TENANT_REQUIRED');
  }
  return normalized;
}

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function addTenantFilter(conditions, params, tenantId, column = 'tenant_id') {
  conditions.push(`${column} = ${pushParam(params, tenantId)}::uuid`);
}

function parsePatientSearchParam(value, fieldName = 'patient') {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const reference = /^Patient\/([0-9a-f-]{36})$/i.exec(text);
  const uid = String(reference?.[1] || text).trim().toLowerCase();
  if (!UUID_RE.test(uid)) {
    throw AppError.badRequest(`${fieldName} must be a patient UUID or Patient/<uuid>`, 'FHIR_BAD_PATIENT');
  }
  return uid;
}

function addPatientFilter(conditions, params, patient, column = 'patient_uid') {
  const patientUid = parsePatientSearchParam(patient);
  if (patientUid) {
    conditions.push(`${column} = ${pushParam(params, patientUid)}::uuid`);
  }
  return patientUid;
}

function paginationSql(params, _count, _offset) {
  return `LIMIT ${pushParam(params, _count)} OFFSET ${pushParam(params, _offset)}`;
}

async function assertPatientInTenant(patientUid, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    patientUid,
    tenantId,
  );
  if (!rows.length) {
    throw AppError.notFound('Patient not found');
  }
  return rows[0];
}

// Audit §3 finding #1 (enumeration oracle). A FHIR Patient read/$everything for
// an UNRESOLVABLE ref (no such patient, or a uid that belongs to a non-PATIENT
// row) previously fell through to the route's own `SELECT … LIMIT 1` and threw
// 404, while a RESOLVED-but-no-relationship patient is denied 403 by the
// care-team guard (on the enforce flip). That 404-vs-403 split is a
// patient-existence oracle. This collapses it to "403-both" by reusing the same
// access-decision primitive the CDS/documents/research export guards use
// (requireResolvedPatient). We run it in shadowMode so it does NOT prematurely
// enforce care-team relationships here — a resolved patient still passes today
// (the app.js mount's shadow patientAccessGuard governs the relationship check,
// and the GO_LIVE flip enforces it uniformly). Only the unresolvable case (an
// early deny that ignores shadowMode) is converted to 403. audit:false avoids
// double-auditing the request the mount guard already shadow-audited.
async function assertFhirPatientResolvable(req, patientUid) {
  const decision = await authorizePatientAccessRequest(req, {
    recordType: 'FHIR_RESOURCE',
    patient: { uid: patientUid },
    requireResolvedPatient: true,
    shadowMode: true,
    audit: false,
  });
  if (!decision.allowed) {
    const payload = patientAccessErrorPayload(decision);
    throw AppError.forbidden(payload.message, payload.code);
  }
}

// Audit §3 finding #2. GET /Patient is a demographics directory (search by
// name/phone). The mount RBAC (FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES) is the broad
// clinical-read set, which is wrong for an unscoped directory: a bedside nurse or
// ward doctor has no business enumerating every patient's name/phone/DOB/address
// with no relationship. Restrict the directory to the front-office / medical-
// records roles whose job is patient lookup, plus admins. Clinical staff still
// reach a specific patient's data through the relationship-scoped resource reads.
function requireFhirDirectoryRole(req) {
  const role = req.user?.role;
  if (
    isAdmin(role)
    || role === 'SUPER_ADMIN'
    || isMedicalRecords(role)
    || role === ROLES.RECEPTIONIST
    || role === ROLES.RECEPTION_INCHARGE
    || role === ROLES.ADMISSION_OFFICER
  ) {
    return;
  }
  throw AppError.forbidden(
    'The FHIR Patient directory search is limited to medical-records and front-office roles',
    'FHIR_DIRECTORY_FORBIDDEN',
  );
}

// Roadmap C3 — write interactions are tighter than the read mount: doctors,
// admins and the integration service account may create resources.
function requireFhirWriteRole(req, resourceType) {
  if (req.smart) {
    const plan = SMART_FHIR_WRITE_RESOURCE_PLAN[resourceType];
    if (plan?.status === 'active') return;
    throw AppError.forbidden(`${resourceType} writes are not active for SMART apps`, 'FHIR_SMART_WRITE_RESOURCE_NOT_ACTIVE');
  }
  const role = req.user?.role;
  if (isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN' || role === ROLES.INTEGRATION_ADMIN) {
    return;
  }
  throw AppError.forbidden('FHIR write interactions require a doctor, admin or integration role', 'FHIR_WRITE_FORBIDDEN');
}

function patientUidFromReference(reference) {
  const patientUid = parsePatientSearchParam(reference, 'subject.reference');
  if (!patientUid || !/^Patient\//i.test(String(reference || '').trim())) {
    throw AppError.badRequest("subject.reference must be 'Patient/<uuid>'", 'FHIR_BAD_SUBJECT');
  }
  return patientUid;
}

function assertValidInbound(resource, expectedType) {
  if (!resource || resource.resourceType !== expectedType) {
    throw AppError.badRequest(`Body must be a FHIR ${expectedType} resource`, 'FHIR_WRONG_RESOURCE_TYPE');
  }
  // Create payloads carry no id (the server assigns one); the validator's
  // required-field list was written for outbound resources, so validate a
  // copy with a placeholder id.
  const verdict = validateResource({ id: 'pending-create', ...resource }, { expectedType });
  if (verdict && verdict.valid === false) {
    throw AppError.badRequest(
      `${expectedType} failed validation: ${(verdict.issues || verdict.errors || []).map((i) => i.message || i).join('; ')}`,
      'FHIR_VALIDATION_FAILED',
    );
  }
}

function conditionCodingsFromFhir(codings = []) {
  return normalizeClinicalCodings((Array.isArray(codings) ? codings : []).map((coding) => ({
    system: coding.system,
    code: coding.code,
    display: coding.display || null,
    coding_role: 'diagnosis',
    source: 'fhir_import',
    metadata: {
      fhir_system: coding.system || null,
    },
  })));
}

// ---------------------------------------------------------------------------
// Middleware: set FHIR content type on all responses from this router
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/fhir+json; charset=utf-8');
  next();
});

// ---------------------------------------------------------------------------
// SMART-on-FHIR scope enforcement (audit §3 deferred MEDIUM).
//
// The platform JWT (staff) path is gated by the app.js mount
// (requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES)) and is the all-or-nothing
// clinical-read grant. A *registered SMART app* authenticates with a SMART
// access token (smart_access_tokens), not a platform JWT, and carries a narrower
// granted-scope set (e.g. `patient/Observation.read`). Those scopes were never
// enforced at the resource boundary.
//
// This middleware closes that gap WITHOUT touching the staff path:
//   - `/metadata` is open (no PHI; the SMART discovery surface).
//   - If a platform JWT already authenticated the request (req.user is set by
//     the global jwtAuth), this is the staff path — pass straight through.
//   - Otherwise, if the Authorization bearer is a recognised SMART access token
//     (smartOAuthService.verifyAccessToken), enforce that the token's granted
//     scopes permit the addressed resourceType + interaction (scopesAllow) and,
//     for a patient-context token, that token.patient_uid matches the addressed
//     patient. Deny → 403 OperationOutcome.
//   - A bearer that is neither a platform JWT (req.user unset ⇒ jwtAuth rejected
//     it upstream, or this router is mounted standalone) nor a SMART token →
//     401 OperationOutcome.
//
// NOTE on the mount: today the app.js global jwtAuth + the FHIR-mount
// requireRole reject any non-platform-JWT bearer BEFORE this router runs, so a
// SMART token cannot currently reach here end-to-end. Wiring a mount-level SMART
// pre-auth (run only when the platform JWT is absent) is the one app.js change
// this needs and is REPORTED separately — the enforcement itself is fully
// contained in this file and is exercised by the router tests.
// ---------------------------------------------------------------------------

// FHIR resource types this router exposes, keyed by the first path segment.
const FHIR_RESOURCE_TYPES = new Set([
  'Patient', 'Appointment', 'Observation', 'MedicationRequest', 'Condition',
  'Procedure', 'DiagnosticReport', 'AllergyIntolerance', 'Encounter',
  'DocumentReference', 'ServiceRequest',
]);

// Map an HTTP method to the SMART interaction it represents for scope checking.
// SMART scopes only distinguish read vs write; GET reads, everything else (POST
// create, PUT/PATCH update, DELETE) is a write.
function smartInteractionForMethod(method) {
  return String(method || '').toUpperCase() === 'GET' ? 'read' : 'write';
}

// Pull the FHIR resourceType being addressed from the request path. The router
// is mounted under /api/v1/fhir, so req.path is e.g. `/Observation`,
// `/Patient/<id>`, `/Patient/<id>/$everything`. Returns null for non-resource
// paths (e.g. /metadata) so the caller can leave them open.
function resourceTypeFromPath(path) {
  const seg = String(path || '').replace(/^\/+/, '').split('/')[0] || '';
  return FHIR_RESOURCE_TYPES.has(seg) ? seg : null;
}

// Resolve the patient UID a request addresses, for patient-context confinement.
// Reuses the same addressing the rest of the router (and fhirPatientContext)
// understands: a /Patient/<uuid> path id, a ?patient= query param, or a
// subject/patient reference in a write body. Returns null when no patient is
// addressed (e.g. an unfiltered search) — a patient-context SMART token is then
// denied by the caller, since it must never run an unscoped query.
export function addressedPatientUid(req, resourceType) {
  // Path id: /Patient/<uuid> (and /Patient/<uuid>/$everything). Parse it from
  // the raw path — router-level middleware runs before route params are bound,
  // so req.params is empty here.
  if (resourceType === 'Patient') {
    const seg = String(req.path || '').replace(/^\/+/, '').split('/');
    const text = String(seg[1] || '').trim().toLowerCase();
    if (UUID_RE.test(text)) return text;
  }
  // ?patient=<uuid> | ?patient=Patient/<uuid>
  let queryPatient = null;
  const q = req.query?.patient;
  if (q !== undefined && q !== null && q !== '') {
    const text = String(q).trim();
    const ref = /^Patient\/([0-9a-f-]{36})$/i.exec(text);
    const uid = String(ref?.[1] || text).trim().toLowerCase();
    if (UUID_RE.test(uid)) queryPatient = uid;
  }
  // Write body: subject.reference / patient.reference = Patient/<uuid>
  let bodyPatient = null;
  const bodyRef = req.body?.subject?.reference || req.body?.patient?.reference;
  if (bodyRef) {
    const ref = /^Patient\/([0-9a-f-]{36})$/i.exec(String(bodyRef).trim());
    const uid = String(ref?.[1] || '').trim().toLowerCase();
    if (UUID_RE.test(uid)) bodyPatient = uid;
  }
  // Sol Ultra #2: for a create/update, the FHIR body is the canonical mutation
  // target — a ?patient= query selector must NOT override it. When both are
  // present and disagree, that is a cross-patient write attempt (the SMART
  // patient-context check below compares the ADDRESSED patient to the token's
  // patient, so returning the query patient would authorize a token scoped to A
  // while the handler writes the body's patient B). Surface the body patient for
  // writes, and reject a conflicting query selector outright.
  if (req.method && req.method !== 'GET' && bodyPatient) {
    if (queryPatient && queryPatient !== bodyPatient) {
      throw smartForbidden(
        'Conflicting SMART patient selectors',
        'FHIR_SMART_PATIENT_SELECTOR_CONFLICT',
      );
    }
    return bodyPatient;
  }
  if (queryPatient) return queryPatient;
  if (bodyPatient) return bodyPatient;
  return null;
}

function smartForbidden(message, code) {
  return AppError.forbidden(message, code);
}

async function enforceSmartScopes(req, res, next) {
  try {
    // /metadata is the open discovery surface — no PHI, no scope needed.
    const resourceType = resourceTypeFromPath(req.path);
    if (!resourceType) return next();

    // Staff path: a platform JWT already authenticated upstream (jwtAuth set
    // req.user) and the mount's requireRole gated the role. Leave it untouched.
    if (req.user && req.user.uid) return next();

    // No platform JWT — this must be a SMART app or it is unauthenticated.
    const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!bearer) {
      throw AppError.unauthorized('Authorization required', 'FHIR_AUTH_REQUIRED');
    }

    let token = null;
    try {
      token = await verifySmartAccessToken({
        tenantId: tenantOf(req),
        accessToken: bearer,
        environment: req.headers['x-smart-environment'] || 'sandbox',
        ipAddress: req.ip,
      });
    } catch (err) {
      logger.warn('SMART access-token verification failed', { error: err.message });
      token = null;
    }

    if (!token) {
      // Neither a platform JWT (req.user is unset) nor a valid SMART token.
      throw AppError.unauthorized('Invalid or expired SMART access token', 'FHIR_SMART_TOKEN_INVALID');
    }

    const grantedScopes = Array.isArray(token.granted_scopes) ? token.granted_scopes : [];
    const interaction = smartInteractionForMethod(req.method);

    // A patient-context token (token.patient_uid set) may use patient/* scopes;
    // a user/system-context token (no patient context) may use user/* or
    // system/* scopes. Check the levels the token is actually entitled to.
    const isPatientContext = !!token.patient_uid;
    const levels = isPatientContext ? ['patient'] : ['user', 'system'];
    const permitted = levels.some((level) => smartScopesAllow(grantedScopes, {
      level,
      resource: resourceType,
      operation: interaction,
    }));
    if (!permitted) {
      throw smartForbidden(
        `SMART scope does not permit ${interaction} on ${resourceType}`,
        'FHIR_SMART_SCOPE_FORBIDDEN',
      );
    }

    // Patient-context confinement: the token is bound to a single patient, so it
    // can only ever address that patient. A request that addresses a different
    // patient — or no patient at all (an unscoped search) — is denied.
    if (isPatientContext) {
      const addressed = addressedPatientUid(req, resourceType);
      if (!addressed) {
        throw smartForbidden(
          'A patient-scoped SMART token must address its own patient',
          'FHIR_SMART_PATIENT_CONTEXT_REQUIRED',
        );
      }
      if (addressed !== String(token.patient_uid).trim().toLowerCase()) {
        throw smartForbidden(
          'SMART token is not authorised for this patient',
          'FHIR_SMART_PATIENT_FORBIDDEN',
        );
      }
    }

    // Expose the SMART principal for downstream handlers + audit. The rest of
    // the router keys authorisation off tenant + addressed patient, so no
    // req.user shim is needed; a SMART app simply has no req.user.
    req.smart = token;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(enforceSmartScopes);

// ---------------------------------------------------------------------------
// Helper: wrap a FHIR resource array in a Bundle (searchset)
// ---------------------------------------------------------------------------
function buildBundle(resourceType, entries) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: entries.length,
    entry: entries.map((resource) => ({
      fullUrl: `${resourceType}/${resource.id}`,
      resource,
    })),
  };
}

function buildEverythingBundle(resources) {
  const entries = resources.filter(Boolean);
  return {
    resourceType: 'Bundle',
    type: 'collection',
    total: entries.length,
    entry: entries.map((resource) => ({
      fullUrl: `${resource.resourceType}/${resource.id}`,
      resource,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Helper: parse _count and _offset query parameters
// ---------------------------------------------------------------------------
function parsePagination(query) {
  const _count = Math.min(Math.max(parseInt(query._count, 10) || 200, 1), 1000);
  const _offset = Math.max(parseInt(query._offset, 10) || 0, 0);
  return { _count, _offset };
}

function isMissingSchemaError(err) {
  const message = String(err?.message || '');
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(message);
}

async function optionalFhirQuery(sql, ...params) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      logger.warn('Optional FHIR source skipped', { error: err.message });
      return [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /metadata — FHIR CapabilityStatement
// ---------------------------------------------------------------------------
router.get(
  '/metadata',
  wrapAsync(async (req, res) => {
    const capabilityStatement = {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: new Date().toISOString(),
      kind: 'instance',
      software: {
        name: 'VH Health FHIR Adapter',
        version: process.env.API_VERSION || '1.0.0',
      },
      fhirVersion: '4.0.1',
      format: ['json'],
      rest: [
        {
          mode: 'server',
          resource: [
            {
              type: 'Patient',
              interaction: [
                { code: 'read' },
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'name', type: 'string' },
                { name: 'phone', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Appointment',
              interaction: [
                { code: 'read' },
              ],
            },
            {
              type: 'Observation',
              interaction: [
                { code: 'search-type' },
                { code: 'create' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'code', type: 'token' },
                { name: 'date', type: 'date' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'MedicationRequest',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'status', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Condition',
              interaction: [
                { code: 'search-type' },
                { code: 'create' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'category', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Procedure',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'DiagnosticReport',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'AllergyIntolerance',
              interaction: [
                { code: 'search-type' },
                { code: 'create' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'Encounter',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'DocumentReference',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: 'type', type: 'token' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
            {
              type: 'ServiceRequest',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
                { name: '_count', type: 'number' },
                { name: '_offset', type: 'number' },
              ],
            },
          ],
        },
      ],
    };

    res.json(capabilityStatement);
  })
);

// ---------------------------------------------------------------------------
// GET /Patient/:id — Read a single Patient resource
// ---------------------------------------------------------------------------
router.get(
  '/Patient/:id/$everything',
  requireFhirExportConsent,
  wrapAsync(async (req, res) => {
    const id = parsePatientSearchParam(req.params.id, 'id');
    const tenantId = tenantOf(req);
    // Finding #1: unresolvable patient ref → 403 (not 404), closing the
    // existence oracle before any record is read.
    await assertFhirPatientResolvable(req, id);
    const { _count } = parsePagination(req.query);

    const [
      patientRows,
      observations,
      meds,
      conditions,
      procedures,
      reports,
      allergies,
      encounters,
      documents,
      serviceRequests,
    ] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
         FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid AND role = 'PATIENT' LIMIT 1`,
        id, tenantId
      ),
      optionalFhirQuery(
        `SELECT CONCAT(v.id, '-', obs.type) AS id, v.patient_uid, obs.type,
                obs.value, obs.unit, v.recorded_at AS recorded_date, v.recorded_by
         FROM vitals_chart v
         CROSS JOIN LATERAL (VALUES
           ('heart_rate', v.heart_rate::text, 'beats/min'),
           ('systolic', v.systolic_bp::text, 'mmHg'),
           ('diastolic', v.diastolic_bp::text, 'mmHg'),
           ('temperature', v.temperature::text, 'Cel'),
           ('spo2', v.spo2::text, '%'),
           ('respiratory_rate', v.respiratory_rate::text, 'breaths/min'),
           ('blood_glucose', v.blood_glucose::text, 'mg/dL')
        ) AS obs(type, value, unit)
         WHERE v.patient_uid = $1::uuid AND v.tenant_id = $2::uuid AND obs.value IS NOT NULL
         ORDER BY v.recorded_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, uid, phone, status, medication, order_note, prescribed_by,
                priority, urgent, ordered_at, created_at
         FROM pharmacy_orders WHERE uid = $1::uuid AND tenant_id = $2::uuid
         ORDER BY created_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, status, icd10_code, icd10_description, description,
                onset_date, resolved_date, diagnosed_by, notes, created_at
         FROM diagnoses WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
         ORDER BY created_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, note_type, title, content, status, procedure_name,
                performed_at, performed_by, author_id, outcome, complications, notes, created_at
         FROM clinical_notes
         WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid AND LOWER(note_type) = 'procedure'
         ORDER BY created_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, uid, status, test_name, investigation_type, results,
                conclusion, interpretation, ordered_at, completed_at, created_at
         FROM investigations
         WHERE (patient_uid = $1::uuid OR uid = $1::uuid) AND tenant_id = $2::uuid
         ORDER BY created_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, allergen, description, name, severity, reaction, recorded_at
         FROM allergies WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
         ORDER BY recorded_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, status, priority, admission_type, reason, reason_for_admission,
                admitting_doctor, attending_doctor, admitted_at, discharged_at,
                discharge_disposition, discharge_type, ward, bed_number
         FROM admissions WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
         ORDER BY admitted_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, note_type, type, title, content, author_id, created_by, created_at
         FROM clinical_notes WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
         ORDER BY created_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
      optionalFhirQuery(
        `SELECT id, patient_uid, status, priority, referring_doctor, requester_id,
                referred_to_doctor, performer_id, referred_to_department,
                reason, clinical_notes, notes, created_at
         FROM referrals WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
         ORDER BY created_at DESC LIMIT $3`,
        id, tenantId, _count
      ),
    ]);

    // Resolvable-as-patient but the direct read missed: keep the 403 contract
    // (the resolvable check above already closed the existence oracle).
    if (!patientRows.length) throw AppError.forbidden('Patient not found', 'FHIR_PATIENT_FORBIDDEN');

    // Longitudinal problem list (roadmap B7) rides along as
    // problem-list-item Conditions.
    const problems = await optionalFhirQuery(
      `SELECT id, patient_uid, title, icd10_code, snomed_code, status, onset_date,
              resolved_date, notes, created_at
       FROM patient_problems WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
       ORDER BY created_at DESC LIMIT $3`,
      id, tenantId, _count
    );

    await attachResourceCodings(conditions, { resourceType: 'diagnosis' });
    await attachResourceCodings(problems, { resourceType: 'patient_problem' });

    const resources = [
      toFhirPatient(patientRows[0]),
      ...observations.map(toFhirObservation),
      ...meds.map(toFhirMedicationRequest),
      ...conditions.map(toFhirCondition),
      ...problems.map(toFhirConditionFromProblem),
      ...procedures.map(toFhirProcedure),
      ...reports.map(toFhirDiagnosticReport),
      ...allergies.map(toFhirAllergyIntolerance),
      ...encounters.map(toFhirEncounter),
      ...documents.map(toFhirDocumentReference),
      ...serviceRequests.map(toFhirServiceRequest),
    ];

    return res.json(buildEverythingBundle(resources));
  })
);

router.get(
  '/Patient/:id',
  wrapAsync(async (req, res) => {
    const id = parsePatientSearchParam(req.params.id, 'id');
    const tenantId = tenantOf(req);
    // Finding #1: unresolvable patient ref → 403 (not 404), closing the
    // existence oracle. A non-PATIENT uid is also unresolvable here (the access
    // resolver filters role='PATIENT'), so this doubles as a guard against the
    // raw read below leaking a staff/admin demographic row.
    await assertFhirPatientResolvable(req, id);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid AND role = 'PATIENT' LIMIT 1`,
      id, tenantId
    );

    if (!rows.length) {
      // Resolvable-as-patient but the direct read missed (tenant/role drift):
      // keep the 403 contract rather than reintroducing the 404 oracle.
      throw AppError.forbidden('Patient not found', 'FHIR_PATIENT_FORBIDDEN');
    }

    // Validate before returning so any adapter drift surfaces as a 500 with an
    // OperationOutcome instead of reaching the peer as invalid FHIR.
    return validatedFhirJson(res, toFhirPatient(rows[0]), { expectedType: 'Patient' });
  })
);

// ---------------------------------------------------------------------------
// GET /Patient — Search patients by name or phone
// ---------------------------------------------------------------------------
router.get(
  '/Patient',
  wrapAsync(async (req, res) => {
    // Finding #2: the directory search is limited to medical-records / front-
    // office roles (+ admin), not the full clinical read set.
    requireFhirDirectoryRole(req);

    const { name, phone } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);
    // Finding #2: the directory must only ever return PATIENT rows — never
    // staff/admin demographics that happen to match the name/phone.
    conditions.push(`role = 'PATIENT'`);

    if (name) {
      conditions.push(`name ILIKE ${pushParam(params, `%${name}%`)}`);
    }

    if (phone) {
      conditions.push(`phone = ${pushParam(params, phone)}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, phone, name, gender, email, birthday, address, profile_picture, is_active
       FROM users ${where} ORDER BY name ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirPatient);
    res.json(buildBundle('Patient', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Appointment/:id — Read a single Appointment resource
// ---------------------------------------------------------------------------
router.get(
  '/Appointment/:id',
  wrapAsync(async (req, res) => {
    const { id } = req.params;
    const tenantId = tenantOf(req);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.uid, a.phone, a.patient_name, a.doctor_id, a.doctor_name,
              a.appointment_date, a.appointment_time, a.status, a.reason, a.notes, a.created_at
       FROM appointments a WHERE a.id = $1 AND a.tenant_id = $2::uuid LIMIT 1`,
      id, tenantId
    );

    if (!rows.length) {
      throw AppError.notFound('Appointment not found');
    }

    return validatedFhirJson(res, toFhirAppointment(rows[0]), { expectedType: 'Appointment' });
  })
);

// ---------------------------------------------------------------------------
// GET /Observation — Search observations (vital signs) by patient, type, date
// ---------------------------------------------------------------------------
router.get(
  '/Observation',
  wrapAsync(async (req, res) => {
    const { patient, code, date } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId, 'v.tenant_id');

    addPatientFilter(conditions, params, patient, 'v.patient_uid');

    if (code) {
      conditions.push(`obs.type ILIKE ${pushParam(params, `%${code}%`)}`);
    }

    if (date) {
      conditions.push(`v.recorded_at::date = ${pushParam(params, date)}::date`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT CONCAT(v.id, '-', obs.type) AS id, v.patient_uid, obs.type,
              obs.value, obs.unit, v.recorded_at AS recorded_date, v.recorded_by
       FROM vitals_chart v
       CROSS JOIN LATERAL (VALUES
         ('heart_rate', v.heart_rate::text, 'beats/min'),
         ('systolic', v.systolic_bp::text, 'mmHg'),
         ('diastolic', v.diastolic_bp::text, 'mmHg'),
         ('temperature', v.temperature::text, 'Cel'),
         ('spo2', v.spo2::text, '%'),
         ('respiratory_rate', v.respiratory_rate::text, 'breaths/min'),
         ('blood_glucose', v.blood_glucose::text, 'mg/dL')
       ) AS obs(type, value, unit)
       ${where} AND obs.value IS NOT NULL
       ORDER BY v.recorded_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirObservation);
    res.json(buildBundle('Observation', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /MedicationRequest — Search medication requests by patient, status
// ---------------------------------------------------------------------------
router.get(
  '/MedicationRequest',
  wrapAsync(async (req, res) => {
    const { patient, status } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);

    addPatientFilter(conditions, params, patient, 'uid');

    if (status) {
      // Map FHIR status back to VH Health status for filtering
      const reverseStatusMap = {
        active: ['PENDING', 'APPROVED'],
        completed: ['DISPENSED', 'DELIVERED'],
        cancelled: ['CANCELLED'],
        stopped: ['REJECTED'],
        'on-hold': ['ON_HOLD'],
      };
      const vhStatuses = reverseStatusMap[status];
      if (vhStatuses && vhStatuses.length > 0) {
        const placeholders = vhStatuses.map((item) => pushParam(params, item)).join(', ');
        conditions.push(`status IN (${placeholders})`);
      }
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone, status, medication, order_note, prescribed_by,
              priority, urgent, ordered_at, created_at
       FROM pharmacy_orders ${where} ORDER BY created_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirMedicationRequest);
    res.json(buildBundle('MedicationRequest', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Condition — Search conditions by patient. Returns BOTH per-encounter
// diagnoses (category encounter-diagnosis) and the longitudinal problem
// list (roadmap B7, category problem-list-item); filter with ?category=.
// ---------------------------------------------------------------------------
router.get(
  '/Condition',
  wrapAsync(async (req, res) => {
    const { patient, category } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const patientUid = parsePatientSearchParam(patient);
    const wantDiagnoses = !category || category === 'encounter-diagnosis';
    const wantProblems = !category || category === 'problem-list-item';

    const resources = [];
    if (wantDiagnoses) {
      const conditions = [];
      const params = [];
      addTenantFilter(conditions, params, tenantId);
      if (patientUid) {
        conditions.push(`patient_uid = ${pushParam(params, patientUid)}::uuid`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const limitOffset = paginationSql(params, _count, _offset);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, patient_uid, status, icd10_code, icd10_description, description,
                onset_date, resolved_date, diagnosed_by, notes, created_at
         FROM diagnoses ${where} ORDER BY created_at DESC ${limitOffset}`,
        ...params
      );
      await attachResourceCodings(rows, { resourceType: 'diagnosis' });
      resources.push(...rows.map(toFhirCondition));
    }
    if (wantProblems) {
      const conditions = [];
      const params = [];
      addTenantFilter(conditions, params, tenantId);
      if (patientUid) {
        conditions.push(`patient_uid = ${pushParam(params, patientUid)}::uuid`);
      }
      const limitOffset = paginationSql(params, _count, _offset);
      const rows = await optionalFhirQuery(
        `SELECT id, patient_uid, title, icd10_code, snomed_code, status, onset_date,
                resolved_date, notes, created_at
         FROM patient_problems
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC ${limitOffset}`,
        ...params
      );
      await attachResourceCodings(rows, { resourceType: 'patient_problem' });
      resources.push(...rows.map(toFhirConditionFromProblem));
    }
    res.json(buildBundle('Condition', resources));
  })
);

// ---------------------------------------------------------------------------
// POST /Condition — create a longitudinal problem-list entry (roadmap C3).
// Routes through the B7 problem-list service so dedupe, terminology
// verdicts and canonical timeline/audit events all apply.
// ---------------------------------------------------------------------------
router.post(
  '/Condition',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req, 'Condition');
    const tenantId = tenantOf(req);
    const resource = req.body;
    assertValidInbound(resource, 'Condition');
    const patientUid = patientUidFromReference(resource.subject?.reference);
    await assertPatientInTenant(patientUid, tenantId);

    const codings = Array.isArray(resource.code?.coding) ? resource.code.coding : [];
    const icd10 = codings.find((c) => String(c.system || '').includes('icd-10'))?.code || null;
    const snomed = codings.find((c) => String(c.system || '').includes('snomed'))?.code || null;
    const clinicalCodings = conditionCodingsFromFhir(codings);
    const title = resource.code?.text
      || codings.find((c) => c.display)?.display
      || icd10 || snomed;
    if (!title) {
      throw AppError.badRequest('Condition.code needs text or a coded display', 'FHIR_CONDITION_NO_CODE');
    }
    const clinical = resource.clinicalStatus?.coding?.[0]?.code || 'active';
    if (!['active', 'recurrence', 'relapse'].includes(clinical)) {
      throw AppError.badRequest(
        'Only active conditions can be created via FHIR; resolve/inactivate through the problem-list API',
        'FHIR_CONDITION_NOT_ACTIVE',
      );
    }

    const result = await createProblem({
      patientUid,
      title,
      icd10Code: icd10,
      snomedCode: snomed,
      onsetDate: resource.onsetDateTime ? String(resource.onsetDateTime).slice(0, 10) : null,
      notes: resource.note?.[0]?.text || null,
      codings: clinicalCodings,
    }, { actorUid: req.user?.uid || req.smart?.user_uid || null, actorRole: req.user?.role || req.smart?.user_role || 'SMART_APP', tenantId });

    res.status(201);
    res.setHeader('Location', `Condition/p-${result.problem.id}`);
    return res.json(toFhirConditionFromProblem(result.problem));
  })
);

// ---------------------------------------------------------------------------
// POST /Observation — create vital-sign observations (roadmap C3). LOINC
// codes map onto one vitals_chart row; NEWS2 + anomaly checks + canonical
// timeline events fire through the standard vitals write path.
// ---------------------------------------------------------------------------
router.post(
  '/Observation/recovery',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req, 'Observation');
    if (req.smart) {
      throw AppError.conflict(
        'SMART OAuth exchanges are not replayable I15 streams',
        'EXTERNAL_RECOVERY_NOT_APPLICABLE',
      );
    }
    if (!req.apiClientId) {
      throw AppError.forbidden(
        'I15 recovery requires a database-backed API client identity',
        'EXTERNAL_RECOVERY_CLIENT_REQUIRED',
      );
    }
    const allowed = new Set(['resource', 'recovery']);
    const unknown = Object.keys(req.body || {}).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw AppError.conflict(
        `I15 recovery request contains unknown fields: ${unknown.join(', ')}`,
        'EXTERNAL_RECOVERY_ENVELOPE_REFUSED',
      );
    }
    const tenantId = tenantOf(req);
    const resource = req.body?.resource;
    assertValidInbound(resource, 'Observation');
    const [recoveryService, vitalsRecoveryService] = await Promise.all([
      import('../../services/integrations/externalInterfaceRecoveryService.js'),
      import('../../services/integrations/externalVitalsRecoveryService.js'),
    ]);
    const {
      enqueueExternalRecoveryItem,
      processNextItemTx,
    } = recoveryService;
    const { validateI15FhirRecovery } = vitalsRecoveryService;
    const prepared = validateI15FhirRecovery({
      tenantId,
      apiClientId: req.apiClientId,
      resource,
      recovery: req.body?.recovery,
    });
    await assertPatientInTenant(prepared.command.patient_uid, tenantId);
    const operation = {
      tenantId,
      offsetId: prepared.offsetId,
      interfaceFamily: prepared.interfaceFamily,
      subpath: prepared.subpath,
      sourcePartition: prepared.sourcePartition,
      generation: prepared.generation,
      sourcePosition: prepared.sourcePosition,
      sourceToken: prepared.sourceToken,
      predecessorToken: prepared.predecessorToken,
      duplicateKey: prepared.duplicateKey,
      occurredAt: prepared.occurredAt,
      command: {
        ...prepared.command,
        actor_uid: req.user?.uid || null,
      },
      commandFingerprint: prepared.commandFingerprint,
    };
    const queued = await enqueueExternalRecoveryItem(operation);
    if (queued.held) {
      throw AppError.conflict(
        'Canonical I15 recovery marker is missing; owner reconciliation is required',
        'EXTERNAL_RECOVERY_MARKER_MISSING',
      );
    }
    const result = queued.duplicate ? queued : await processNextItemTx(operation);
    return res.status(202).json({
      resourceType: 'Parameters',
      parameter: [{ name: 'recovery', valueString: JSON.stringify(result) }],
    });
  }),
);

router.post(
  '/Observation',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req, 'Observation');
    const tenantId = tenantOf(req);
    const resource = req.body;
    assertValidInbound(resource, 'Observation');
    const patientUid = patientUidFromReference(resource.subject?.reference);
    await assertPatientInTenant(patientUid, tenantId);

    const mappedResult = fhirObservationToVitals(resource);
    if (mappedResult.mapped.length === 0) {
      throw AppError.badRequest(
        `No supported vital-sign LOINC codes found (unsupported: ${mappedResult.unmapped.join(', ') || 'none'})`,
        'FHIR_OBSERVATION_UNSUPPORTED_CODES',
      );
    }

    const result = await recordVitals({
      patient_uid: patientUid,
      tenant_id: tenantId,
      ...mappedResult.vitals,
      temperature_unit: mappedResult.temperatureUnit || undefined,
      recorded_at: mappedResult.effective || undefined,
      notes: `FHIR Observation create (${mappedResult.mapped.join(', ')})`,
      recorded_by: req.user?.uid || req.smart?.user_uid || null,
      source: 'fhir',
    });
    const row = result?.vitals || result;

    res.status(201);
    res.setHeader('Location', `Observation/vitals-${row.id}`);
    return res.json({
      resourceType: 'Observation',
      id: `vitals-${row.id}`,
      status: 'final',
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: 'vital-signs',
        }],
      }],
      code: resource.code,
      subject: { reference: `Patient/${patientUid}` },
      effectiveDateTime: row.recorded_at,
      component: mappedResult.mapped.map((loinc) => ({
        code: { coding: [{ system: 'http://loinc.org', code: loinc }] },
      })),
    });
  })
);

// ---------------------------------------------------------------------------
// POST /AllergyIntolerance — create a structured allergy (roadmap C3).
// Lands in patient_allergies, the store every CDS consumer reads (A10).
// ---------------------------------------------------------------------------
router.post(
  '/AllergyIntolerance',
  wrapAsync(async (req, res) => {
    requireFhirWriteRole(req, 'AllergyIntolerance');
    const tenantId = tenantOf(req);
    const resource = req.body;
    assertValidInbound(resource, 'AllergyIntolerance');
    const patientUid = patientUidFromReference(resource.patient?.reference || resource.subject?.reference);
    await assertPatientInTenant(patientUid, tenantId);

    const allergen = resource.code?.text
      || resource.code?.coding?.find((c) => c.display)?.display
      || resource.code?.coding?.[0]?.code;
    if (!allergen) {
      throw AppError.badRequest('AllergyIntolerance.code needs text or a coded display', 'FHIR_ALLERGY_NO_CODE');
    }
    const criticality = String(resource.criticality || '').toLowerCase();
    const reactionSeverity = String(resource.reaction?.[0]?.severity || '').toLowerCase();
    const severity = criticality === 'high' || reactionSeverity === 'severe' ? 'SEVERE'
      : reactionSeverity === 'moderate' ? 'MODERATE'
        : 'MILD';
    const reactionText = resource.reaction?.[0]?.manifestation?.[0]?.text
      || resource.reaction?.[0]?.description || null;

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_allergies (patient_uid, allergy_name, severity, reaction, is_active, tenant_id, created_at)
       SELECT u.uid, $2, $3, $4, true, $5::uuid, NOW()
         FROM users u WHERE u.uid = $1::uuid AND u.tenant_id = $5::uuid
       RETURNING id, patient_uid, allergy_name, severity, reaction, created_at`,
      patientUid, String(allergen).trim(), severity, reactionText, tenantId,
    );
    if (!rows.length) throw AppError.notFound('Patient not found');
    const created = rows[0];

    res.status(201);
    res.setHeader('Location', `AllergyIntolerance/pa-${created.id}`);
    return res.json({
      resourceType: 'AllergyIntolerance',
      id: `pa-${created.id}`,
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
      },
      code: { text: created.allergy_name },
      patient: { reference: `Patient/${created.patient_uid}` },
      criticality: severity === 'SEVERE' ? 'high' : 'low',
      reaction: created.reaction ? [{ manifestation: [{ text: created.reaction }] }] : [],
      recordedDate: created.created_at,
    });
  })
);

// ---------------------------------------------------------------------------
// GET /Procedure — Search procedures by patient
// ---------------------------------------------------------------------------
router.get(
  '/Procedure',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);
    addPatientFilter(conditions, params, patient);

    conditions.push(`LOWER(note_type) = 'procedure'`);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, note_type, title, content, status, procedure_name,
              performed_at, performed_by, author_id, outcome, complications, notes, created_at
       FROM clinical_notes ${where} ORDER BY created_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirProcedure);
    res.json(buildBundle('Procedure', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /DiagnosticReport — Search diagnostic reports (investigations) by patient
// ---------------------------------------------------------------------------
router.get(
  '/DiagnosticReport',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);

    const patientUid = parsePatientSearchParam(patient);
    if (patientUid) {
      const patientParam = pushParam(params, patientUid);
      conditions.push(`(patient_uid = ${patientParam}::uuid OR uid = ${patientParam}::uuid)`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, uid, status, test_name, investigation_type, results,
              conclusion, interpretation, ordered_at, completed_at, created_at
       FROM investigations ${where} ORDER BY created_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirDiagnosticReport);
    res.json(buildBundle('DiagnosticReport', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /AllergyIntolerance — Search patient allergies
// ---------------------------------------------------------------------------
router.get(
  '/AllergyIntolerance',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);
    addPatientFilter(conditions, params, patient);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, allergen, description, name, severity, reaction, recorded_at
       FROM allergies ${where} ORDER BY recorded_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirAllergyIntolerance);
    res.json(buildBundle('AllergyIntolerance', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /Encounter — Search patient encounters (admissions)
// ---------------------------------------------------------------------------
router.get(
  '/Encounter',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);
    addPatientFilter(conditions, params, patient);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status, priority, admission_type, reason, reason_for_admission,
              admitting_doctor, attending_doctor, admitted_at, discharged_at,
              discharge_disposition, discharge_type, ward, bed_number
       FROM admissions ${where} ORDER BY admitted_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirEncounter);
    res.json(buildBundle('Encounter', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /DocumentReference — Search clinical documents by patient and type
// ---------------------------------------------------------------------------
router.get(
  '/DocumentReference',
  wrapAsync(async (req, res) => {
    const { patient, type } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);
    addPatientFilter(conditions, params, patient);

    if (type) {
      conditions.push(`note_type ILIKE ${pushParam(params, `%${type}%`)}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, note_type, type, title, content, author_id, created_by, created_at
       FROM clinical_notes ${where} ORDER BY created_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirDocumentReference);
    res.json(buildBundle('DocumentReference', resources));
  })
);

// ---------------------------------------------------------------------------
// GET /ServiceRequest — Search referrals by patient
// ---------------------------------------------------------------------------
router.get(
  '/ServiceRequest',
  wrapAsync(async (req, res) => {
    const { patient } = req.query;
    const tenantId = tenantOf(req);
    const { _count, _offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    addTenantFilter(conditions, params, tenantId);
    addPatientFilter(conditions, params, patient);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limitOffset = paginationSql(params, _count, _offset);

    const rows = await optionalFhirQuery(
      `SELECT id, patient_uid, status, priority, referring_doctor, requester_id,
              referred_to_doctor, performer_id, referred_to_department,
              reason, clinical_notes, notes, created_at
       FROM referrals ${where} ORDER BY created_at DESC ${limitOffset}`,
      ...params
    );

    const resources = rows.map(toFhirServiceRequest);
    res.json(buildBundle('ServiceRequest', resources));
  })
);

// ---------------------------------------------------------------------------
// FHIR error contract (roadmap C3): failures leave this router as
// OperationOutcome, not the platform envelope.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 500) logger.error('FHIR endpoint error:', err);
  res.status(status).json({
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code: status === 404 ? 'not-found'
        : status === 403 ? 'forbidden'
          : status === 409 ? 'conflict'
            : status === 400 ? 'invalid'
              : 'exception',
      diagnostics: status >= 500 ? 'Internal server error' : String(err?.message || 'Request failed'),
      details: err?.code ? { text: err.code } : undefined,
    }],
  });
});

export default router;
