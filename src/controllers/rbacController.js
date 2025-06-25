import { success, error } from '../utils/responseHelper.js';
import { ADMIN, DOCTOR, PATIENT, HR_STAFF, GENERAL_STAFF } from '../utils/roles.js';
import db from '../config/database.js';
import { logAudit } from '../utils/logAudit.js';

const allRoles = [ADMIN, DOCTOR, PATIENT, HR_STAFF, GENERAL_STAFF];

/**
 * ✅ List all valid roles
 */
export async function getAllRoles(req, res) {
  success(res, allRoles, 'Available roles');
}

/**
 * ✅ List all users grouped by role
 */
export async function getUsersByRole(req, res) {
  try {
    const result = await db.query(
      "SELECT role, COUNT(*) as count, json_agg(json_build_object('uid', uid, 'phone', phone, 'name', name)) as users FROM users GROUP BY role ORDER BY role ASC"
    );
    success(res, result.rows, 'Users by role');
  } catch (err) {
    error(res, 'Failed to fetch users by role');
  }
}

/**
 * ✅ Assign a role to a user (admin-only)
 */
export async function assignUserRole(req, res) {
  const { phone, role } = req.body;

  if (!phone || !role || !allRoles.includes(role)) {
    return error(res, 'Valid phone and role are required', 400);
  }

  if (req.user?.role !== ADMIN) {
    return error(res, 'Only admins can assign roles', 403);
  }

  try {
    const current = await db.query('SELECT role FROM users WHERE phone = $1', [phone]);
    if (!current.rows.length) return error(res, 'User not found', 404);

    const oldRole = current.rows[0].role;
    if (oldRole === role) return success(res, { phone, role }, 'Role unchanged');

    await db.query('UPDATE users SET role = $1 WHERE phone = $2', [role, phone]);

    await logAudit(req, 'admin-assign-role', {
      phone,
      oldRole,
      newRole: role
    });

    success(res, { phone, role }, 'Role assigned');
  } catch (err) {
    error(res, 'Failed to assign role');
  }
}
