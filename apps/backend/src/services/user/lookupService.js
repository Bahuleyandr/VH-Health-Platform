import { Prisma } from '@prisma/client';
import { USER_CONFIG } from '../../config/userConfig.js';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

function buildLookupSelect(userRole) {
  if (userRole === USER_CONFIG.ROLES.ADMIN) {
    return `
      uid,
      phone,
      name,
      email,
      role,
      registered_at,
      COALESCE(updated_at, registered_at) AS last_login,
      profile_picture,
      address,
      birthday,
      anniversary
    `;
  }

  if (['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
    return `
      uid,
      phone,
      name,
      email,
      role,
      registered_at
    `;
  }

  return `
    uid,
    phone,
    name,
    registered_at,
    role
  `;
}

export class LookupService {
  // Basic user lookup
  static async lookupUser(searchParams, userRole, requestedBy) {
    const { phone, uid, name, email, limit = 10 } = searchParams;

    if (!phone && !uid && !name && !email) {
      throw AppError.badRequest('Provide at least one search parameter', 'LOOKUP_CRITERIA_REQUIRED');
    }

    const recentLookups = await prisma.audit_logs.count({
      where: {
        uid: requestedBy,
        action: 'user-lookup',
        created_at: {
          gt: new Date(Date.now() - 60 * 60 * 1000),
        },
      },
    });

    const maxLookups = USER_CONFIG.PRIVACY.MAX_LOOKUPS_PER_HOUR[userRole] ||
      USER_CONFIG.PRIVACY.MAX_LOOKUPS_PER_HOUR.DEFAULT;

    if (recentLookups >= maxLookups) {
      throw new Error('Lookup rate limit exceeded. Please try again later.');
    }

    const searchConditions = [];

    if (phone) {
      searchConditions.push(Prisma.sql`phone = ${normalizePhone(phone)}`);
    }

    if (uid) {
      searchConditions.push(Prisma.sql`uid = ${uid}::uuid`);
    }

    if (name) {
      searchConditions.push(Prisma.sql`LOWER(name) LIKE ${`%${name.toLowerCase()}%`}`);
    }

    if (email && ['ADMIN', 'DOCTOR'].includes(userRole)) {
      searchConditions.push(Prisma.sql`LOWER(email) LIKE ${`%${email.toLowerCase()}%`}`);
    }

    if (searchConditions.length === 0) {
      // e.g. a non-admin/doctor supplying only `email` — no usable criterion.
      throw AppError.badRequest(
        'Provide at least one usable search parameter',
        'LOOKUP_CRITERIA_REQUIRED',
      );
    }

    // CAN-056: OR the search criteria together, but AND the non-admin role
    // restriction onto the whole group. Previously the role guard was pushed
    // into the same OR list, so a non-matching lookup degraded to
    // `WHERE <miss> OR role != 'ADMIN'` and leaked the entire non-admin roster.
    const whereParts = [Prisma.sql`(${Prisma.join(searchConditions, ' OR ')})`];
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      whereParts.push(Prisma.sql`role != ${USER_CONFIG.ROLES.ADMIN}`);
    }
    const whereClause = Prisma.sql`WHERE ${Prisma.join(whereParts, ' AND ')}`;
    const parsedLimit = Math.min(parseInt(limit, 10) || 10, userRole === 'ADMIN' ? 50 : 20);

    const result = await prisma.$queryRaw(
      Prisma.sql`
        SELECT ${Prisma.raw(buildLookupSelect(userRole))}
        FROM users
        ${whereClause}
        ORDER BY registered_at DESC
        LIMIT ${parsedLimit}
      `
    );

    const filteredResults = result.map((user) => {
      if (userRole !== USER_CONFIG.ROLES.ADMIN) {
        delete user.last_login;
        delete user.address;
        delete user.birthday;
        delete user.anniversary;

        if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
          user.phone = user.phone
            ? user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****'
            : null;
        }
      }
      return user;
    });

    await prisma.audit_logs.create({
      data: {
        uid: requestedBy,
        role: userRole,
        action: 'user-lookup',
        resource: 'users',
        metadata: { searchParams, resultsCount: filteredResults.length },
      },
    });

    return filteredResults;
  }

  // Quick user verification
  static async verifyUser(identifier, userRole, requestedBy) {
    const { phone, uid } = identifier;

    if (!phone && !uid) {
      throw new Error('Provide phone or uid for verification');
    }

    const user = await prisma.users.findFirst({
      where: uid
        ? { uid }
        : { phone: normalizePhone(phone) },
      select: {
        uid: true,
        phone: true,
        name: true,
        role: true,
        registered_at: true,
      },
    });

    if (!user) {
      await prisma.audit_logs.create({
        data: {
          uid: requestedBy,
          role: userRole,
          action: 'user-verification-failed',
          resource: 'users',
          metadata: identifier,
        },
      });

      return { verified: false, exists: false };
    }

    if (userRole !== USER_CONFIG.ROLES.ADMIN && !['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
      user.phone = user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****';
    }

    await prisma.audit_logs.create({
      data: {
        uid: requestedBy,
        role: userRole,
        action: 'user-verification-success',
        resource: 'users',
        resource_id: user.uid,
        metadata: { foundUser: user.uid },
      },
    });

    return {
      verified: true,
      exists: true,
      user,
    };
  }

  // Get user statistics
  static async getUserStatistics(detailed = false, userRole) {
    const basicStats = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days')::int AS new_users_30d,
        COUNT(*) FILTER (WHERE COALESCE(updated_at, registered_at) > NOW() - INTERVAL '7 days')::int AS active_users_7d,
        COUNT(*) FILTER (WHERE COALESCE(updated_at, registered_at) > NOW() - INTERVAL '30 days')::int AS active_users_30d,
        COUNT(DISTINCT role)::int AS unique_roles,
        MIN(registered_at) AS first_registration,
        MAX(registered_at) AS latest_registration
      FROM users
    `;

    const roleDistribution = await prisma.$queryRaw`
      SELECT role, COUNT(*)::int AS count
      FROM users
      GROUP BY role
      ORDER BY count DESC
    `;

    const responseData = {
      overallStats: basicStats[0],
      roleDistribution,
    };

    if (detailed && userRole === USER_CONFIG.ROLES.ADMIN) {
      const [registrationTrends, loginActivity, ageDistribution, departmentStats] = await Promise.all([
        prisma.$queryRaw`
          SELECT DATE(registered_at) AS date, COUNT(*)::int AS registrations
          FROM users
          WHERE registered_at > NOW() - INTERVAL '30 days'
          GROUP BY DATE(registered_at)
          ORDER BY date DESC
        `,
        prisma.$queryRaw`
          SELECT
            COUNT(*) FILTER (WHERE COALESCE(updated_at, registered_at) > NOW() - INTERVAL '1 day')::int AS logins_1d,
            COUNT(*) FILTER (WHERE COALESCE(updated_at, registered_at) > NOW() - INTERVAL '7 days')::int AS logins_7d,
            COUNT(*) FILTER (WHERE COALESCE(updated_at, registered_at) > NOW() - INTERVAL '30 days')::int AS logins_30d,
            0::int AS never_logged_in,
            AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(updated_at, registered_at))) / 86400) AS avg_days_since_login
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
          FROM users
          WHERE role = 'PATIENT' AND birthday IS NOT NULL
          GROUP BY age_group
          ORDER BY count DESC
        `,
        prisma.$queryRaw`
          SELECT d.department, d.specialty AS specialization, COUNT(u.uid)::int AS staff_count
          FROM doctors d
          LEFT JOIN users u ON d.user_id = u.id
          GROUP BY d.department, d.specialty
          ORDER BY staff_count DESC
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

  // Get recent user activity
  static async getRecentActivity(days = 7, limit = 50) {
    const daysInt = parseInt(days, 10) || 7;
    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);

    const result = await prisma.$queryRaw`
      SELECT
        u.uid, u.phone, u.name, u.role,
        COALESCE(u.updated_at, u.registered_at) AS last_login,
        u.registered_at,
        CASE
          WHEN COALESCE(u.updated_at, u.registered_at) > NOW() - INTERVAL '1 day' THEN 'Very Active'
          WHEN COALESCE(u.updated_at, u.registered_at) > NOW() - INTERVAL '7 days' THEN 'Active'
          WHEN COALESCE(u.updated_at, u.registered_at) > NOW() - INTERVAL '30 days' THEN 'Inactive'
          ELSE 'Long Inactive'
        END AS activity_status
      FROM users u
      WHERE u.registered_at > NOW() - (${daysInt} * INTERVAL '1 day')
         OR COALESCE(u.updated_at, u.registered_at) > NOW() - (${daysInt} * INTERVAL '1 day')
      ORDER BY COALESCE(u.updated_at, u.registered_at) DESC
      LIMIT ${parsedLimit}
    `;

    return result;
  }

  // Bulk user search
  static async bulkSearch(criteria, options = {}) {
    const { includeInactive = true, sortBy = 'registered_at', sortOrder = 'DESC', limit = 100 } = options;

    const conditions = [Prisma.sql`1=1`];

    if (criteria.role) {
      conditions.push(Prisma.sql`u.role = ${criteria.role.toUpperCase()}`);
    }

    if (criteria.registeredAfter) {
      conditions.push(Prisma.sql`u.registered_at >= ${criteria.registeredAfter}::timestamp`);
    }

    if (criteria.registeredBefore) {
      conditions.push(Prisma.sql`u.registered_at <= ${criteria.registeredBefore}::timestamp`);
    }

    if (criteria.namePattern) {
      conditions.push(Prisma.sql`LOWER(u.name) LIKE ${`%${criteria.namePattern.toLowerCase()}%`}`);
    }

    if (criteria.phonePattern) {
      conditions.push(Prisma.sql`u.phone LIKE ${`%${criteria.phonePattern}%`}`);
    }

    if (!includeInactive) {
      conditions.push(Prisma.sql`COALESCE(u.updated_at, u.registered_at) > NOW() - INTERVAL '30 days'`);
    }

    const allowedSortFields = {
      name: 'u.name',
      registered_at: 'u.registered_at',
      last_login: 'COALESCE(u.updated_at, u.registered_at)',
      role: 'u.role',
      phone: 'u.phone',
    };
    const sortField = allowedSortFields[sortBy] || allowedSortFields.registered_at;
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const parsedLimit = Math.min(parseInt(limit, 10) || 100, 500);

    const result = await prisma.$queryRaw`
      SELECT
        u.id,
        u.uid,
        u.phone,
        u.name,
        u.email,
        u.gender,
        u.role,
        NULL::text AS department,
        NULL::text AS specialty,
        NULL::text AS employee_id,
        u.is_active,
        CASE WHEN u.is_active THEN 'active' ELSE 'inactive' END AS status,
        u.registered_at,
        u.updated_at,
        COALESCE(u.updated_at, u.registered_at) AS last_login
      FROM users u
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${Prisma.raw(sortField)} ${Prisma.raw(order)}
      LIMIT ${parsedLimit}
    `;

    return result;
  }
}
