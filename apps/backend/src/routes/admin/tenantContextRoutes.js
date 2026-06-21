// src/routes/admin/tenantContextRoutes.js
//
// W5 S1 — GET /api/v1/admin/tenant-context: the CALLER's own tenant identity +
// branding, for the admin portal to render its tenant (name, logo, primary
// colour). Self-scoped to `req.tenantId` (set by tenantContextMiddleware from
// the token's tenant_id claim; a SUPER_ADMIN acting-as via the audited
// x-tenant-id override gets the acted tenant). Takes NO tenant param, so a
// regular ADMIN can only ever read their own tenant. This is the ADMIN-level
// read surface — distinct from the SUPER_ADMIN-only /admin/tenants management
// CRUD. No PHI, no secrets: only public-facing branding + identity.
import express from 'express';
import { getTenantById } from '../../services/tenant/tenantService.js';
import { getBranding } from '../../services/tenant/tenantSettingsService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return error(res, 'Tenant context unavailable', 404, 'TENANT_CONTEXT_UNAVAILABLE');
    }
    const [tenant, branding] = await Promise.all([
      getTenantById(tenantId),
      getBranding(tenantId),
    ]);
    const name = tenant?.name || 'VH Health';
    return success(res, {
      id: tenantId,
      slug: tenant?.slug || null,
      name,
      region: tenant?.region || 'IN',
      branding: {
        // `name` falls back to the tenant name so the chrome always has a label
        // even before a tenant configures settings.branding (NO-OP default).
        name: branding.name || name,
        logoUrl: branding.logoUrl || null,
        primaryColor: branding.primaryColor || null,
        supportEmail: branding.supportEmail || null,
      },
    }, 'Tenant context');
  } catch (err) {
    return next(err);
  }
});

export default router;
