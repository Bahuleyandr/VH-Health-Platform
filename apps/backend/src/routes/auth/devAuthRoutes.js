// src/routes/auth/devAuthRoutes.js
// Development-only auth shortcuts. Mounted in routes/auth/index.js ONLY
// when ENABLE_DEV_AUTH=true. Lets the patient app obtain a real JWT
// without a working Firebase OTP flow - needed because emulators / CI
// environments cannot complete a real phone-OTP round-trip.
//
// SECURITY: must never be reachable unless explicitly enabled. The mount-time guard
// in routes/auth/index.js is the single source of truth; this file does
// not re-check NODE_ENV because the import itself only happens after the
// ENABLE_DEV_AUTH gate passes.

import express from 'express';

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateToken } from '../../utils/jwtUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

const DEFAULT_DEV_PHONE = '+919999999999';

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
    const rawPhone = req.body?.phone || DEFAULT_DEV_PHONE;
    const name = req.body?.name || 'Dev Patient';
    const phone = normalizePhone(rawPhone);

    let user = await prisma.users.findFirst({
      where: { phone },
      select: {
        uid: true, id: true, name: true, phone: true, email: true,
        role: true, gender: true, is_active: true,
      },
    });

    let isNewUser = false;
    if (!user) {
      user = await prisma.users.create({
        data: {
          phone,
          role: 'PATIENT',
          name,
          registered_at: new Date(),
          last_sign_in_at: new Date(),
        },
        select: {
          uid: true, id: true, name: true, phone: true, email: true,
          role: true, gender: true, is_active: true,
        },
      });
      isNewUser = true;
      logger.info(`[dev-login] created patient ${phone} (${user.uid})`);
    } else {
      await prisma.users.update({
        where: { uid: user.uid },
        data: { last_sign_in_at: new Date() },
      });
      logger.info(`[dev-login] existing patient ${phone} (${user.uid})`);
    }

    const accessToken = generateToken({
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      role: user.role,
    });

    return success(res, {
      accessToken,
      user: {
        uid: user.uid,
        id: user.id,
        phone: user.phone,
        name: user.name,
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
