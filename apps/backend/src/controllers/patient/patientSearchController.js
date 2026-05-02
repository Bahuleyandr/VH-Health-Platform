// src/controllers/patient/patientSearchController.js
//
// Lightweight patient lookup for clinical staff.
//
// Backs the staff app's global patient picker (Cmd+K modal). Returns a
// short list of patients matching the query string against name, phone,
// or ABHA address. Result is intentionally small — uid/name/age/gender/phone
// — because the picker just needs enough to render the row and route to
// /emr/timeline/:uid?name=… on tap. Full chart fetches happen via the
// EMR endpoints once the user lands on the patient screen.
//
// Why this lives at /api/v1/patients/search instead of reusing
// /api/v1/users/search:
//   * /users is RBAC'd to [PATIENT, GENERAL_STAFF, ADMIN] — clinical
//     roles 403 there, by design (it exposes admin-style filters like
//     `registeredAfter`, `lastLoginAfter`, full role enumeration).
//   * Clinical staff need a narrower verb: "find a patient by name or
//     phone, give me 20 rows max, no PII filters." A dedicated
//     endpoint keeps the search surface auditable and lets us add
//     IDOR/PHI guarding here without weakening the admin one.
//
// PHI access is still logged via the route-level `phiAccessLogger`
// middleware in `routes/patient/patientSearchRoutes.js`.

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { error, success } from '../../utils/responseHelper.js';

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 20;

export const searchPatients = async (req, res) => {
  try {
    const raw = (req.query.q ?? req.query.query ?? '').toString().trim();
    if (raw.length < MIN_QUERY_LENGTH) {
      // Return empty list rather than 400 — UI debounces, may fire with
      // a 1-char query while the user is still typing.
      return success(res, { patients: [], count: 0 }, 'Patient search results');
    }
    const q = raw.toLowerCase();
    const limit = Math.min(
      MAX_RESULTS,
      parseInt(req.query.limit, 10) || MAX_RESULTS,
    );

    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.uid, u.name, u.phone, u.gender, u.abha_address,
              CASE WHEN u.birthday IS NOT NULL
                   THEN DATE_PART('year', AGE(u.birthday))::int
              END AS age
         FROM users u
        WHERE u.role = 'PATIENT'
          AND u.is_active = true
          AND (
            LOWER(COALESCE(u.name, '')) LIKE $1
            OR LOWER(COALESCE(u.phone, '')) LIKE $1
            OR LOWER(COALESCE(u.abha_address, '')) LIKE $1
          )
        ORDER BY
          CASE WHEN LOWER(COALESCE(u.name, '')) LIKE $2 THEN 0 ELSE 1 END,
          u.name ASC
        LIMIT $3`,
      `%${q}%`, `${q}%`, limit,
    );

    success(
      res,
      { patients: rows, count: rows.length, query: raw },
      'Patient search results',
    );
  } catch (err) {
    logger.error('Patient search error:', err);
    error(res, 'Patient search failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
