// src/routes/admin/services/activityService.js
//
// CAN-015 (audit 2026-06-27): the recent-activity feed unions rows from
// appointments, users and sos_alerts. The caller's tenant id is threaded in as
// the first arg and every source query ANDs `tenant_id = $1::uuid` (parameterized;
// limit/offset shift to $2/$3) so an admin only sees its own tenant's activity.
// Defense-in-depth alongside RLS.
import { tableExists, safeQuery } from './common.js';

export async function getRecentActivity(tenantId, limit = 50, offset = 0) {
  const sources = [];

  if (await tableExists('appointments')) {
    sources.push(
      safeQuery(
        `
        SELECT 'appointment' AS type,
               'Appointment created' AS description,
               created_at AS timestamp,
               NULL::text AS user_id
        FROM appointments
        WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
          AND tenant_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [tenantId, limit, offset],
        'activity.appt_created'
      ),
      safeQuery(
        `
        SELECT 'appointment_completed' AS type,
               'Appointment completed' AS description,
               COALESCE(updated_at, created_at) AS timestamp,
               NULL::text AS user_id
        FROM appointments
        WHERE status = 'completed'
          AND COALESCE(updated_at, created_at) >= CURRENT_DATE - INTERVAL '7 days'
          AND tenant_id = $1::uuid
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT $2 OFFSET $3
        `,
        [tenantId, limit, offset],
        'activity.appt_completed'
      )
    );
  }

  if (await tableExists('users')) {
    // users.registered_at is the canonical column for new-user timestamps
    // (the schema has no `created_at` on users — see prisma/schema.prisma#users).
    sources.push(
      safeQuery(
        `
        SELECT 'user' AS type,
               'New user registered' AS description,
               registered_at AS timestamp,
               (uid)::text AS user_id
        FROM users
        WHERE registered_at >= CURRENT_DATE - INTERVAL '7 days'
          AND tenant_id = $1::uuid
        ORDER BY registered_at DESC
        LIMIT $2 OFFSET $3
        `,
        [tenantId, limit, offset],
        'activity.users'
      )
    );
  }

  if (await tableExists('sos_alerts')) {
    sources.push(
      safeQuery(
        `
        SELECT 'emergency' AS type,
               CONCAT('SOS alert (', COALESCE(status, 'new'), ')') AS description,
               created_at AS timestamp,
               NULL::text AS user_id
        FROM sos_alerts
        WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
          AND tenant_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [tenantId, limit, offset],
        'activity.sos'
      )
    );
  }

  const resultSets = await Promise.all(sources);
  const all = resultSets.flat();

  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return all.slice(0, limit);
}

export default { getRecentActivity };
