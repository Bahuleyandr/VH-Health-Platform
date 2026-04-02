// src/services/user/lookupService.js
// Migrated from raw pg to Prisma ORM

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { USER_CONFIG } from '../../config/userConfig.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

export class LookupService {
  static async lookupUser(searchParams, userRole, requestedBy) {
    const { phone, uid, name, email, limit = 10 } = searchParams;

    if (!phone && !uid && !name && !email) {
      throw new Error('Provide at least one search parameter');
    }

    // Rate limit check
    const recentRows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM audit_logs
      WHERE uid = ${requestedBy}::uuid
        AND action = 'user-lookup'
        AND created_at > NOW() - INTERVAL '1 hour'
    `;
    const lookupCount = recentRows[0].count;
    const maxLookups = USER_CONFIG.PRIVACY?.MAX_LOOKUPS_PER_HOUR?.[userRole] ||
                       USER_CONFIG.PRIVACY?.MAX_LOOKUPS_PER_HOUR?.DEFAULT || 100;

    if (lookupCount >= maxLookups) {
      throw new Error('Lookup rate limit exceeded. Please try again later.');
    }

    // Build field list by role
    let baseFields;
    if (userRole === USER_CONFIG.ROLES.ADMIN) {
      baseFields = 'uid, phone, name, email, role, registered_at, last_login, profile_picture, address, birthday, anniversary';
    } else if (['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
      baseFields = 'uid, phone, name, email, role, registered_at';
    } else {
      baseFields = 'uid, phone, name, registered_at, role';
    }

    const conditions = [];
    if (phone) conditions.push(Prisma.sql`phone = ${normalizePhone(phone)}`);
    if (uid) conditions.push(Prisma.sql`uid = ${uid}::uuid`);
    if (name) conditions.push(Prisma.sql`LOWER(name) LIKE ${`%${name.toLowerCase()}%`}`);
    if (email && ['ADMIN', 'DOCTOR'].includes(userRole)) {
      conditions.push(Prisma.sql`LOWER(email) LIKE ${`%${email.toLowerCase()}%`}`);
    }
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      conditions.push(Prisma.sql`role != ${USER_CONFIG.ROLES.ADMIN}`);
    }

    const whereClause = Prisma.join(conditions, ' OR ');
    const maxLimit = userRole === 'ADMIN' ? 50 : 20;
    const limitNum = Math.min(parseInt(limit), maxLimit);

    const users = await prisma.$queryRaw`
      SELECT ${Prisma.raw(baseFields)} FROM users
      WHERE ${whereClause}
      ORDER BY registered_at DESC
      LIMIT ${limitNum}
    `;

    const filtered = users.map(user => {
      const u = { ...user };
      if (userRole !== USER_CONFIG.ROLES.ADMIN) {
        delete u.last_login;
        delete u.address;
        delete u.birthday;
        delete u.anniversary;
        if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
          u.phone = u.phone
            ? u.phone.slice(0, -(USER_CONFIG.PRIVACY?.PHONE_MASK_LENGTH || 4)) + '****'
            : null;
        }
      }
      return u;
    });

    // Audit log
    await prisma.audit_logs.create({
      data: {
        uid: requestedBy || null,
        action: 'user-lookup',
        metadata: { searchParams, resultsCount: filtered.length },
      },
    });

    return filtered;
  }

  static async verifyUser(identifier, userRole, requestedBy) {
    const { phone, uid } = identifier;
    if (!phone && !uid) throw new Error('Provide phone or uid for verification');

    let rows;
    if (uid) {
      rows = await prisma.$queryRaw`
        SELECT uid, phone, name, role, registered_at FROM users WHERE uid = ${uid}::uuid
      `;
    } else {
      rows = await prisma.$queryRaw`
        SELECT uid, phone, name, role, registered_at FROM users WHERE phone = ${normalizePhone(phone)}
      `;
    }

    if (rows.length === 0) {
      await prisma.audit_logs.create({
        data: {
          uid: requestedBy || null,
          action: 'user-verification-failed',
          metadata: identifier,
        },
      });
      return { verified: false, exists: false };
    }

    const user = { ...rows[0] };
    if (userRole !== USER_CONFIG.ROLES.ADMIN && !['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
      user.phone = user.phone.slice(0, -(USER_CONFIG.PRIVACY?.PHONE_MASK_LENGTH || 4)) + '****';
    }

    await prisma.audit_logs.create({
      data: {
        uid: requestedBy || null,
        action: 'user-verification-success',
        metadata: { foundUser: user.uid },
      },
    });

    return { verified: true, exists: true, user };
  }

  static async getUserStatistics(detailed = false, userRole) {
    const [basicStats, roleDistribution] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          COUNT(*)::int                                                              AS total_users,
          COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days')::int  AS new_users_30d,
          COUNT(*) FILTER (WHERE last_login   > NOW() - INTERVAL '7 days')::int    AS active_users_7d,
          COUNT(*) FILTER (WHERE last_login   > NOW() - INTERVAL '30 days')::int   AS active_users_30d,
          COUNT(DISTINCT role)::int                                                 AS unique_roles,
          MIN(registered_at) AS first_registration,
          MAX(registered_at) AS latest_registration
        FROM users
      `,
      prisma.$queryRaw`
        SELECT role, COUNT(*)::int AS count
        FROM users GROUP BY role ORDER BY count DESC
      `,
    ]);

    const responseData = {
      overallStats: basicStats[0],
      roleDistribution,
    };

    if (detailed && userRole === USER_CONFIG.ROLES.ADMIN) {
      const [registrationTrends, loginActivity, ageDistribution, departmentStats] = await Promise.all([
        prisma.$queryRaw`
          SELECT DATE(registered_at) AS date, COUNT(*)::int AS registrations
          FROM users WHERE registered_at > NOW() - INTERVAL '30 days'
          GROUP BY DATE(registered_at) ORDER BY date DESC
        `,
        prisma.$queryRaw`
          SELECT
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '1 day')::int   AS logins_1d,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days')::int  AS logins_7d,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days')::int AS logins_30d,
            COUNT(*) FILTER (WHERE last_login IS NULL)::int                      AS never_logged_in,
            AVG(EXTRACT(EPOCH FROM (NOW() - last_login))/86400) AS avg_days_since_login
          FROM users
        `,
        prisma.$queryRaw`
          SELECT
            CASE
              WHEN EXTRACT(YEAR FROM AGE(birthday)) < 18 THEN 'Under 18'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 18 AND 30 THEN '18-30'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 31 AND 50 THEN '31-50'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 51 AND 70 THEN '51-70'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) > 70 THEN 'Over 70'
              ELSE 'Unknown'
            END AS age_group,
            COUNT(*)::int AS count
          FROM users WHERE role = 'PATIENT' AND birthday IS NOT NULL
          GROUP BY age_group ORDER BY count DESC
        `,
        prisma.$queryRaw`
          SELECT d.department, d.specialty AS specialization, COUNT(u.uid)::int AS staff_count
          FROM doctors d LEFT JOIN users u ON d.user_uid = u.uid
          GROUP BY d.department, d.specialty ORDER BY staff_count DESC
        `,
      ]);

      responseData.detailedStats = {
        registrationTrends,
        loginActivity: loginActivity[0],
        ageDistribution,
        departmentStats,
      };
    }

    return responseData;
  }

  static async getRecentActivity(days = 7, limit = 50) {
    const daysInt = parseInt(days);
    const rows = await prisma.$queryRaw`
      SELECT
        u.uid, u.phone, u.name, u.role, u.last_login, u.registered_at,
        CASE
          WHEN u.last_login > NOW() - INTERVAL '1 day'   THEN 'Very Active'
          WHEN u.last_login > NOW() - INTERVAL '7 days'  THEN 'Active'
          WHEN u.last_login > NOW() - INTERVAL '30 days' THEN 'Inactive'
          ELSE 'Long Inactive'
        END AS activity_status
      FROM users u
      WHERE u.registered_at > NOW() - (${daysInt} || ' days')::interval
         OR u.last_login    > NOW() - (${daysInt} || ' days')::interval
      ORDER BY COALESCE(u.last_login, u.registered_at) DESC
      LIMIT ${Math.min(parseInt(limit), 100)}
    `;
    return rows;
  }

  static async bulkSearch(criteria, options = {}) {
    const { includeInactive = true, sortBy = 'registered_at', sortOrder = 'DESC', limit = 100 } = options;

    const conditions = [Prisma.sql`1=1`];
    if (criteria.role) conditions.push(Prisma.sql`role = ${criteria.role.toUpperCase()}`);
    if (criteria.registeredAfter) conditions.push(Prisma.sql`registered_at >= ${new Date(criteria.registeredAfter)}`);
    if (criteria.registeredBefore) conditions.push(Prisma.sql`registered_at <= ${new Date(criteria.registeredBefore)}`);
    if (criteria.namePattern) conditions.push(Prisma.sql`LOWER(name) LIKE ${`%${criteria.namePattern.toLowerCase()}%`}`);
    if (criteria.phonePattern) conditions.push(Prisma.sql`phone LIKE ${`%${criteria.phonePattern}%`}`);
    if (!includeInactive) conditions.push(Prisma.sql`last_login > NOW() - INTERVAL '30 days'`);

    const whereClause = Prisma.join(conditions, ' AND ');

    const allowedSortFields = ['name', 'registered_at', 'last_login', 'role', 'phone'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'registered_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

    return prisma.$queryRaw`
      SELECT id, uid, phone, name, email, gender, role,
             is_active, registered_at, updated_at, last_login
      FROM users
      WHERE ${whereClause}
      ORDER BY ${Prisma.raw(sortField)} ${order}
      LIMIT ${Math.min(parseInt(limit), 500)}
    `;
  }
}
