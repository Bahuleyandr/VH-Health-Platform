// NL-13 P4 — nuclear-medicine & radiotherapy coordination routes.
// Mounted at /api/v1/radiation-oncology (app.js) behind clinical-staff RBAC +
// patientAccessGuard + PHI logging. Thin handlers: validation + canonical writes +
// per-tenant enablement + privilege gates all live in radiationCoordinationService.

import { Router } from 'express';
import {
  getRadiationCoordinationSettings,
  setRadiationCoordinationSettings,
  createReferral,
  listReferrals,
  getReferralDetail,
  transitionReferralStatus,
  createPlanRef,
  transitionPlanStatus,
  scheduleFraction,
  transitionFractionStatus,
  createNuclearOrder,
  transitionNuclearOrderStatus,
  recordRadioisotopeAdministration,
  recordSafetyEvidence,
  listSafetyEvidence,
} from '../../services/clinical/radiationCoordinationService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isLeadership, isDoctor } from '../../utils/roleHelpers.js';

const router = Router();

const canManage = (role) => isAdmin(role) || isLeadership(role) || isDoctor(role) || role === 'SUPER_ADMIN';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function contextOf(req) {
  return { actorUid: req.user?.uid || null, actorRole: req.user?.role || null };
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

// ── settings ─────────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const settings = await getRadiationCoordinationSettings({ tenantId: tenantOf(req) });
    return success(res, { settings }, 'Radiation coordination settings');
  } catch (err) {
    return handleFailure(res, err, 'get coordination settings');
  }
});

router.patch('/settings', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership manage radiation coordination settings', HTTP_STATUS.FORBIDDEN);
    const settings = await setRadiationCoordinationSettings({
      tenantId: tenantOf(req),
      enabled: req.body.enabled === true,
      aerbEvidenceOwner: req.body.aerb_evidence_owner || null,
      ownerSourcePolicyRef: req.body.owner_source_policy_ref || null,
      planningSystemVendorRef: req.body.planning_system_vendor_ref || null,
      acceptanceSnapshot: req.body.acceptance_snapshot || null,
    }, contextOf(req));
    return success(res, { settings }, 'Radiation coordination settings updated');
  } catch (err) {
    return handleFailure(res, err, 'update coordination settings');
  }
});

// ── referrals ─────────────────────────────────────────────────────────────

router.get('/referrals', async (req, res) => {
  try {
    const referrals = await listReferrals({
      tenantId: tenantOf(req),
      patientUid: req.query.patient_uid || null,
      status: req.query.status || null,
      limit: req.query.limit || 100,
    });
    return success(res, { referrals, count: referrals.length }, 'Radiation-oncology referrals');
  } catch (err) {
    return handleFailure(res, err, 'list referrals');
  }
});

router.post('/referrals', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create radiation-oncology referrals', HTTP_STATUS.FORBIDDEN);
    const referral = await createReferral({ ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { referral }, 'Radiation-oncology referral created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create referral');
  }
});

router.get('/referrals/:id', async (req, res) => {
  try {
    const referral = await getReferralDetail(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { referral }, 'Radiation-oncology referral');
  } catch (err) {
    return handleFailure(res, err, 'get referral');
  }
});

router.post('/referrals/:id/status', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership update referral status', HTTP_STATUS.FORBIDDEN);
    const referral = await transitionReferralStatus(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { referral }, 'Radiation-oncology referral status updated');
  } catch (err) {
    return handleFailure(res, err, 'update referral status');
  }
});

// ── radiotherapy plan references ─────────────────────────────────────────

router.post('/referrals/:id/plan-refs', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership record plan references', HTTP_STATUS.FORBIDDEN);
    const planRef = await createPlanRef(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { plan_ref: planRef }, 'Radiotherapy plan reference recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create plan reference');
  }
});

router.post('/plan-refs/:id/status', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership update plan status', HTTP_STATUS.FORBIDDEN);
    const planRef = await transitionPlanStatus(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { plan_ref: planRef }, 'Radiotherapy plan status updated');
  } catch (err) {
    return handleFailure(res, err, 'update plan status');
  }
});

// ── radiotherapy fraction schedules ──────────────────────────────────────

router.post('/plan-refs/:id/fractions', async (req, res) => {
  try {
    const fraction = await scheduleFraction(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { fraction }, 'Radiotherapy fraction scheduled', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'schedule fraction');
  }
});

router.post('/fractions/:id/status', async (req, res) => {
  try {
    const fraction = await transitionFractionStatus(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { fraction }, 'Radiotherapy fraction status updated');
  } catch (err) {
    return handleFailure(res, err, 'update fraction status');
  }
});

// ── nuclear-medicine orders + administration ─────────────────────────────

router.post('/nuclear-orders', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create nuclear-medicine orders', HTTP_STATUS.FORBIDDEN);
    const order = await createNuclearOrder({ ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { order }, 'Nuclear-medicine order created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create nuclear-medicine order');
  }
});

router.post('/nuclear-orders/:id/status', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership update nuclear-medicine order status', HTTP_STATUS.FORBIDDEN);
    const order = await transitionNuclearOrderStatus(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { order }, 'Nuclear-medicine order status updated');
  } catch (err) {
    return handleFailure(res, err, 'update nuclear-medicine order status');
  }
});

router.post('/nuclear-orders/:id/administrations', async (req, res) => {
  try {
    const administration = await recordRadioisotopeAdministration(req.params.id, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { administration }, 'Radioisotope administration recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record radioisotope administration');
  }
});

// ── radiation safety evidence (register/audit) ───────────────────────────

router.get('/safety-evidence', async (req, res) => {
  try {
    const evidence = await listSafetyEvidence({
      tenantId: tenantOf(req),
      evidenceType: req.query.evidence_type || null,
      status: req.query.status || null,
      limit: req.query.limit || 100,
    });
    return success(res, { evidence, count: evidence.length }, 'Radiation safety evidence');
  } catch (err) {
    return handleFailure(res, err, 'list safety evidence');
  }
});

router.post('/safety-evidence', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership record radiation safety evidence', HTTP_STATUS.FORBIDDEN);
    const evidence = await recordSafetyEvidence({ ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, { evidence }, 'Radiation safety evidence recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record safety evidence');
  }
});

export default router;
