import { Router } from 'express';
import { validationResult } from 'express-validator';
import {
  approveCampaign,
  createEngagementCampaign,
  createEngagementTemplate,
  dryRunCampaign,
  getEngagementSettings,
  materializeCampaignRecipients,
  queueDueCampaignRecipients,
  submitCampaignForApproval,
  upsertEngagementSettings,
} from '../../services/engagement/engagementCampaignService.js';
import { success } from '../../utils/responseHelper.js';
import { paramId } from '../../validators/sharedValidators.js';
import {
  getEngagementCampaign,
  listEngagementCampaigns,
  listEngagementTemplates,
} from './engagementListQueries.js';

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  return next();
};

function tenantIdFor(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId;
}

function actorUidFor(req) {
  return req.user?.uid || req.user?.user_uid || null;
}

function actorRoleFor(req) {
  return req.user?.role || null;
}

router.get('/settings', async (req, res, next) => {
  try {
    const settings = await getEngagementSettings(tenantIdFor(req));
    return success(res, settings, 'Engagement settings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const settings = await upsertEngagementSettings(tenantIdFor(req), req.body || {}, actorUidFor(req));
    return success(res, settings, 'Engagement settings updated');
  } catch (err) {
    return next(err);
  }
});

// ─── Reads ───────────────────────────────────────────────────────────────────
// Added because this router could not list what it created: with only POST
// verbs, a campaign left in `pending_approval` was reachable only from the
// browser session that submitted it, so nobody else could open it to approve
// it. These are pure tenant-scoped reads (see ./engagementListQueries.js).
//
// The approval service binds the transition to the immutable `submitted_by`
// identity, rejects self-approval, and requires a reason. These reads make that
// second-person review operable from a separate session.
//
// Envelope + pagination follow the neighbouring admin list convention
// (controllers/gamification/gamificationController.js#getHistory):
//   success(res, { <collection>, pagination: buildPagination(total, page, limit) })

router.get('/templates', async (req, res, next) => {
  try {
    const result = await listEngagementTemplates(tenantIdFor(req), req.query || {});
    return success(res, result, 'Engagement templates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/campaigns', async (req, res, next) => {
  try {
    const result = await listEngagementCampaigns(tenantIdFor(req), req.query || {});
    return success(res, result, 'Engagement campaigns retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/campaigns/:campaignId', paramId('campaignId'), validate, async (req, res, next) => {
  try {
    const campaign = await getEngagementCampaign(tenantIdFor(req), req.params.campaignId);
    return success(res, campaign, 'Engagement campaign retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/templates', async (req, res, next) => {
  try {
    const template = await createEngagementTemplate(tenantIdFor(req), req.body || {}, actorUidFor(req));
    return success(res, template, 'Engagement template created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/campaigns', async (req, res, next) => {
  try {
    const campaign = await createEngagementCampaign(tenantIdFor(req), req.body || {}, actorUidFor(req));
    return success(res, campaign, 'Engagement campaign created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/campaigns/:campaignId/dry-run', paramId('campaignId'), validate, async (req, res, next) => {
  try {
    const result = await dryRunCampaign({
      tenantId: tenantIdFor(req),
      campaignId: req.params.campaignId,
      input: req.body || {},
      actorUid: actorUidFor(req),
    });
    return success(res, result, 'Engagement campaign dry run completed');
  } catch (err) {
    return next(err);
  }
});

router.post('/campaigns/:campaignId/materialize', paramId('campaignId'), validate, async (req, res, next) => {
  try {
    const result = await materializeCampaignRecipients({
      tenantId: tenantIdFor(req),
      campaignId: req.params.campaignId,
      input: req.body || {},
      actorUid: actorUidFor(req),
    });
    return success(res, result, 'Engagement campaign recipients materialized');
  } catch (err) {
    return next(err);
  }
});

router.post('/campaigns/:campaignId/submit-approval', paramId('campaignId'), validate, async (req, res, next) => {
  try {
    const campaign = await submitCampaignForApproval({
      tenantId: tenantIdFor(req),
      campaignId: req.params.campaignId,
      actorUid: actorUidFor(req),
      actorRole: actorRoleFor(req),
      reason: req.body?.reason || null,
    });
    return success(res, campaign, 'Engagement campaign submitted for approval');
  } catch (err) {
    return next(err);
  }
});

router.post('/campaigns/:campaignId/approve', paramId('campaignId'), validate, async (req, res, next) => {
  try {
    const campaign = await approveCampaign({
      tenantId: tenantIdFor(req),
      campaignId: req.params.campaignId,
      actorUid: actorUidFor(req),
      actorRole: actorRoleFor(req),
      reason: req.body?.reason || null,
    });
    return success(res, campaign, 'Engagement campaign approved');
  } catch (err) {
    return next(err);
  }
});

router.post('/campaigns/:campaignId/queue-due', paramId('campaignId'), validate, async (req, res, next) => {
  try {
    const result = await queueDueCampaignRecipients({
      tenantId: tenantIdFor(req),
      campaignId: req.params.campaignId,
      limit: req.body?.limit || req.query?.limit,
    });
    return success(res, result, 'Engagement campaign due recipients queued');
  } catch (err) {
    return next(err);
  }
});

export default router;
