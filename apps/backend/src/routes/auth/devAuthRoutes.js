// src/routes/auth/devAuthRoutes.js
// Development-only auth shortcuts. Mounted in routes/auth/index.js ONLY
// when isDevAuthEnabled() is true — which hard-requires NODE_ENV to not be
// production AND ENABLE_DEV_AUTH=true (utils/authCompatibilityGates.js).
// Lets the patient app obtain a real JWT without a working Firebase OTP
// flow - needed because emulators / CI environments cannot complete a real
// phone-OTP round-trip.
//
// SECURITY: must never be reachable unless explicitly enabled. The mount-time
// guard in routes/auth/index.js is the fail-closed control: in production this
// file is never even imported. A former in-file requireProductionSecret()
// branch (a shared-secret check that only ran when NODE_ENV=production) was
// removed as unreachable dead code — production can never execute this router,
// and the branch's non-timing-safe compare would have been a defect had it
// ever run. Guard hard-fails below in case the mount contract is ever broken.

import express from 'express';

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { generateToken } from '../../utils/jwtUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';
import { ensureHospitalNumber } from '../../services/patient/patientIdentifierService.js';
import { isDevAuthEnabled } from '../../utils/authCompatibilityGates.js';

const router = express.Router();

const DEFAULT_DEV_PHONE = '+919999999999';

// Belt-and-braces re-assertion of the mount-time contract: if this router is
// ever mounted outside the isDevAuthEnabled() gate (refactor accident), every
// request fails closed instead of minting JWTs.
function assertDevAuthEnabled(req, res) {
  if (isDevAuthEnabled()) return true;
  error(res, 'Dev auth is disabled', HTTP_STATUS.FORBIDDEN);
  return false;
}

/**
 * POST /api/v1/auth/dev/patient-login
 *
 * Body: { phone?: string, name?: string }
 *
 * If `phone` is omitted, defaults to +919999999999 (a non-callable test
 * number). Looks up the user by phone; creates one with role=PATIENT if
 * missing. Returns the same envelope as /firebase/firebase-login so the
 * client can drop-in replace.
 */
router.post('/patient-login', async (req, res) => {
  try {
    if (!assertDevAuthEnabled(req, res)) return;

    const rawPhone = req.body?.phone || DEFAULT_DEV_PHONE;
    const name = req.body?.name || 'Dev Patient';
    const phone = normalizePhone(rawPhone);

    let user = await prisma.users.findFirst({
      where: { phone },
      select: {
        uid: true, id: true, tenant_id: true, name: true, phone: true, email: true,
        role: true, gender: true, is_active: true,
      },
    });

    let isNewUser = false;
    if (!user) {
      const now = new Date();
      user = await prisma.users.create({
        data: {
          phone,
          role: 'PATIENT',
          name,
          registered_at: now,
          updated_at: now,
          last_sign_in_at: now,
        },
        select: {
          uid: true, id: true, tenant_id: true, name: true, phone: true, email: true,
          role: true, gender: true, is_active: true,
        },
      });
      isNewUser = true;
      logger.info(`[dev-login] created patient ${maskPhoneForLog(phone)} (${user.uid})`);
    } else {
      await prisma.users.update({
        where: { uid: user.uid },
        data: { last_sign_in_at: new Date(), updated_at: new Date() },
      });
      logger.info(`[dev-login] existing patient ${maskPhoneForLog(phone)} (${user.uid})`);
    }

    const hospitalNumber = await ensureHospitalNumber({
      tenantId: user.tenant_id || null,
      patientUid: user.uid,
      createdBy: user.uid,
    });

    const accessToken = generateToken({
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      role: user.role,
      // W4 C5: stamp the patient's tenant (already selected above). Omitted when
      // null so tenantContextMiddleware resolves it; dev-only path regardless.
      tenant_id: user.tenant_id ?? undefined,
    });

    return success(res, {
      accessToken,
      user: {
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        name: user.name,
        hospital_number: hospitalNumber,
        email: user.email,
        role: user.role,
        profileComplete: !!(user.name && user.gender),
        emailVerified: false, // users table has no email_verified column
        isActive: user.is_active !== false,
        isNewUser,
      },
      isNewUser,
    }, isNewUser ? 'Dev patient created' : 'Dev login successful');
  } catch (err) {
    logger.error('[dev-login] error', { message: err.message, stack: err.stack });
    return error(res, 'Dev login failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
