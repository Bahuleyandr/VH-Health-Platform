import { AppError } from '../../utils/AppError.js';

export function parseDoctorRef(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function doctorRefError(message, code, details = null) {
  return AppError.badRequest(message, code, details);
}

export async function resolveDoctorRef(db, value) {
  const ref = parseDoctorRef(value);
  if (!ref) {
    throw doctorRefError('doctor_id must be a positive integer', 'INVALID_DOCTOR_REF');
  }

  const rows = await db.$queryRawUnsafe(
    `WITH input_user AS (
       SELECT id, uid, name, role, is_active
         FROM users
        WHERE id = $1::int
        LIMIT 1
     ),
     direct_doctor AS (
       SELECT
         u.id,
         u.uid,
         u.name,
         u.role,
         d.id AS doctor_row_id,
         COALESCE(dept.name, d.department) AS department
       FROM users u
       LEFT JOIN LATERAL (
         SELECT d2.*
           FROM doctors d2
          WHERE d2.user_id = u.id
          ORDER BY CASE WHEN d2.is_active = true THEN 0 ELSE 1 END, d2.id ASC
          LIMIT 1
       ) d ON true
       LEFT JOIN departments dept ON dept.id = d.department_id
      WHERE u.id = $1::int
        AND u.role = 'DOCTOR'
        AND u.is_active = true
        AND COALESCE(d.is_active, true) = true
     ),
     profile_doctor AS (
       SELECT
         u.id,
         u.uid,
         u.name,
         u.role,
         d.id AS doctor_row_id,
         COALESCE(dept.name, d.department) AS department
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN departments dept ON dept.id = d.department_id
      WHERE d.id = $1::int
        AND d.is_active = true
        AND u.role = 'DOCTOR'
        AND u.is_active = true
     )
     SELECT
       (SELECT row_to_json(input_user) FROM input_user) AS input_user,
       (SELECT row_to_json(direct_doctor) FROM direct_doctor) AS direct_doctor,
       (SELECT row_to_json(profile_doctor) FROM profile_doctor) AS profile_doctor`,
    ref,
  );

  const result = rows[0] || {};
  const inputUser = result.input_user || null;
  const direct = result.direct_doctor || null;
  const profile = result.profile_doctor || null;

  // Appointment flows store the canonical users.id. If a doctors.id happens to
  // collide with an active doctor user id, keep the explicit user match.
  if (!direct && profile && inputUser && Number(inputUser.id) !== Number(profile.id)) {
    throw doctorRefError(
      `doctor_id ${ref} is ambiguous: it matches a ${inputUser.role || 'non-doctor'} user and a doctor profile`,
      'AMBIGUOUS_DOCTOR_REF',
      {
        ref,
        users_id: inputUser.id,
        users_role: inputUser.role,
        doctors_id: profile.doctor_row_id,
        doctors_user_id: profile.id,
      },
    );
  }

  const resolved = direct || profile;
  if (!resolved) return null;

  return {
    id: Number(resolved.id),
    uid: resolved.uid,
    name: resolved.name,
    role: 'DOCTOR',
    department: resolved.department || null,
    doctor_row_id: resolved.doctor_row_id == null ? null : Number(resolved.doctor_row_id),
    source: direct ? 'users.id' : 'doctors.id',
  };
}
