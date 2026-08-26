// src/routes/compliance/pcpndtRoutes.js — Sprint 18

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import * as pcpndt from '../../services/compliance/pcpndtService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { positiveIntOrNull } from '../../middleware/routePatientAccessGuards.js';

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
      // Shared relay (responseHelper.relayAppError): surfaces AppError
      // code+details per the documented envelope; non-AppErrors get a logged
      // generic 500 that never relays raw err.message.
      return relayAppError(res, err, 'PCPNDT error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// ── Patient-access guards (re-audit 2026-08, M: mount guards) ────────
//
// The CLINICAL_WORKFLOW patientAccessGuard used to sit on the app.js mount
// (CAN-051). A mount-level middleware runs BEFORE Express matches the route,
// so req.params is empty there; GET /form-f/:id carries the patient only
// behind the row id, so resolvePatientForAccess found nothing and
// authorizePatientAccessRequest returned no_patient_context without
// evaluating a policy — in shadow AND in enforce. Only POST /form-f, whose
// body can carry patient_uid, ever produced a real decision at the mount.
//
// The guard now sits on the two Form-F routes that can serve one patient's
// data, with an explicit patientSelector that resolves THE ROW THE HANDLER
// IS ABOUT TO SERVE, tenant-scoped (same pattern as
// bcmaRoutes.guardWristbandView and the abdmHiuRoutes selector factories).
//
// Unlike the death-certification mirror of this fix, these guards do NOT set
// requirePatientContext: pcpndt_form_f.patient_uid is NULLABLE by design
// ("internal link, not on the form") — the Act requires Form F for every
// scanned woman, registered VH patient or not, and pcpndtService's
// assertPatientInTenant deliberately skips a missing patient_uid. Forcing a
// patient context here would lock out the statutory register for unlinked
// walk-ins. So: when the row/body carries a linked patient the guard
// evaluates the real policy against that patient; when there is legitimately
// no linked patient it passes as no_patient_context and the requireStaff /
// requireAdmin role gates remain the authority.
//
// Machines, sonologists, the Form-F register listing (GET /form-f), and the
// monthly submission rollups have no single patient subject — role gates
// only; a patient guard there could never resolve a subject and would be a
// control that can never fire.
//
// Mode governance is carried over from the mount unchanged:
// careTeamModeGoverned stays true, so the per-tenant
// care_team_enforcement_mode flag ('shadow' by default) governs these
// routes. CLINICAL_WORKFLOW resolves to the
// patient.clinical_workflow.access policy
// (accessPolicyRegistry.policyCodeForRecordType).

// Delegates to the shared int4-capped parser. The local copy lacked the
// int4 cap, so a 10-digit id reached the ::int bind and threw 22003 —
// a guard 500 on malformed input, violating the never-throw contract.
function positiveInt(value) {
  return positiveIntOrNull(value);
}

const pcpndtGuard = (patientSelector) => patientAccessGuard('CLINICAL_WORKFLOW', {
  careTeamModeGoverned: true,
  patientSelector,
});

// POST /form-f carries the (optional) subject only in the body — resolve it
// exactly the way createFormF will (body.patient_uid).
const guardFormFCreate = pcpndtGuard((req) => ({ uid: req.body?.patient_uid }));

// GET /form-f/:id — the (optional) linked patient behind the Form-F row the
// handler loads. A malformed id returns null (clean pass-through to the role
// gate + handler 404), never a throw.
const guardFormFById = pcpndtGuard(async (req) => {
  const formFId = positiveInt(req.params?.id);
  if (formFId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM pcpndt_form_f
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    formFId,
  );
  return rows[0] ?? null;
});

// Machines
router.get('/machines', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listMachines({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));
router.post('/machines', requireAdmin, wrap(async (req) =>
  pcpndt.upsertMachine({ ...req.body, tenantId: tenantOf(req) }),
));

// Sonologists
router.get('/sonologists', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listSonologists({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));
router.post('/sonologists', requireAdmin, wrap(async (req) =>
  pcpndt.upsertSonologist({ ...req.body, tenantId: tenantOf(req) }),
));
router.patch('/sonologists/:id', requireAdmin, wrap(async (req) =>
  pcpndt.upsertSonologist({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
  }),
));

// Form F
router.post('/form-f', requireStaffOrAdmin, guardFormFCreate, wrap(async (req) =>
  pcpndt.createFormF({
    ...req.body,
    tenantId: tenantOf(req), created_by: req.user?.uid,
  }),
));
router.get('/form-f', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listFormF({
    tenantId: tenantOf(req),
    from: req.query.from,
    to: req.query.to,
    sonologist_id: req.query.sonologist_id,
    status: req.query.status,
    limit: req.query.limit,
  }),
));
router.get('/form-f/:id', requireStaffOrAdmin, guardFormFById, wrap(async (req) =>
  pcpndt.getFormF({ tenantId: tenantOf(req), id: req.params.id }),
));

// Monthly submission rollup
router.post('/submissions/generate', requireAdmin, wrap(async (req) =>
  pcpndt.generateMonthlySubmission({
    tenantId: tenantOf(req),
    period_year: req.body.period_year,
    period_month: req.body.period_month,
    generated_by: req.user?.uid,
  }),
));
router.get('/submissions', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listSubmissions({
    tenantId: tenantOf(req), limit: req.query.limit,
  }),
));
router.post('/submissions/:id/acknowledge', requireAdmin, wrap(async (req) =>
  pcpndt.acknowledgeSubmission({
    tenantId: tenantOf(req), id: req.params.id,
    authority_reference: req.body.authority_reference,
    notes: req.body.notes,
  }),
));

export default router;
