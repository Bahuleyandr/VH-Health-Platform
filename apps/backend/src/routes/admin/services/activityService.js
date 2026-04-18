// src/routes/admin/services/activityService.js
import { tableExists, safeQuery } from './common.js';

export async function getRecentActivity(limit = 50, offset = 0) {
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
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset],
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
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset],
        'activity.appt_completed'
      )
    );
  }

  if (await tableExists('users')) {
    sources.push(
      safeQuery(
        `
        SELECT 'user' AS type,
               'New user registered' AS description,
               created_at AS timestamp,
               (uid)::text AS user_id
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset],
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
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset],
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
