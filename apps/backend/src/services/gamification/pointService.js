// src/services/gamification/pointService.js
// Core gamification engine — idempotent point awards, streaks, milestones

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// ── Core idempotent point award ───────────────────────────────────────────────

export async function awardPoints(userUid, { activityType, activityRefId, points, description }, tenantId = null) {
  try {
    // CAN-012: when a tenant is resolvable, scope the idempotency check and stamp
    // the ledger row explicitly. These awards fire from event/background hooks
    // where the RLS AsyncLocalStorage isn't seeded, so without the explicit
    // tenant_id the INSERT would fall back to the GUC DEFAULT tenant — wrong for
    // a non-default tenant. user_uid is globally unique so the read risk is low;
    // this is defense-in-depth + write-correctness.
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM health_point_ledger
       WHERE user_uid = $1::uuid AND activity_type = $2 AND activity_ref_id = $3${tenantId ? ' AND tenant_id = $4::uuid' : ''}
       LIMIT 1`,
      ...(tenantId ? [userUid, activityType, activityRefId, tenantId] : [userUid, activityType, activityRefId])
    );

    if (existing.length > 0) {
      return null; // Already awarded
    }

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO health_point_ledger (user_uid, points, activity_type, activity_ref_id, description${tenantId ? ', tenant_id' : ''})
       VALUES ($1::uuid, $2, $3, $4, $5${tenantId ? ', $6::uuid' : ''})
       RETURNING id, user_uid, points, activity_type, activity_ref_id, description, earned_at`,
      ...(tenantId ? [userUid, points, activityType, activityRefId, description, tenantId] : [userUid, points, activityType, activityRefId, description])
    );

    return rows[0] || null;
  } catch (err) {
    // Unique constraint violation — treat as idempotent duplicate
    if (err.code === 'P2002' || (err.message && err.message.includes('uq_hpl_idempotency'))) {
      return null;
    }
    logger.warn('awardPoints error', { error: err.message, userUid, activityType });
    throw err;
  }
}

// ── Appointment completed: 50 pts ─────────────────────────────────────────────

export async function awardAppointmentPoints(appointment) {
  try {
    const phone = appointment.phone;
    if (!phone) return null;

    // CAN-019: resolve the user within the appointment's tenant. These award
    // hooks run from event/background contexts where the RLS AsyncLocalStorage
    // is not seeded, so the explicit tenant predicate is the only scoping — a
    // phone is unique only per tenant (mig 333).
    const apptTenantId = appointment.tenant_id || appointment.tenantId || null;
    const users = apptTenantId
      ? await prisma.$queryRawUnsafe(
          `SELECT uid FROM users WHERE phone = $1 AND tenant_id = $2::uuid LIMIT 1`,
          phone, apptTenantId)
      : await prisma.$queryRawUnsafe(
          `SELECT uid FROM users WHERE phone = $1 LIMIT 1`,
          phone);
    if (users.length === 0) return null;
    const userUid = users[0].uid;

    const result = await awardPoints(userUid, {
      activityType: 'APPOINTMENT_COMPLETED',
      activityRefId: String(appointment.id),
      points: 50,
      description: 'Completed appointment visit',
    }, apptTenantId);

    // If already awarded, skip streak check
    if (!result) return null;

    // Fire streak check
    await checkAppointmentStreak(userUid, apptTenantId);

    return result;
  } catch (err) {
    logger.warn('awardAppointmentPoints error', { error: err.message });
    return null;
  }
}

// ── On-time bonus: 25 pts if IN_PROGRESS within 15 min of scheduled time ──────

export async function awardOnTimeBonus(appointment) {
  try {
    const phone = appointment.phone;
    if (!phone) return null;

    // CAN-019: resolve within the appointment's tenant (see awardAppointmentPoints).
    const apptTenantId = appointment.tenant_id || appointment.tenantId || null;
    const users = apptTenantId
      ? await prisma.$queryRawUnsafe(
          `SELECT uid FROM users WHERE phone = $1 AND tenant_id = $2::uuid LIMIT 1`,
          phone, apptTenantId)
      : await prisma.$queryRawUnsafe(
          `SELECT uid FROM users WHERE phone = $1 LIMIT 1`,
          phone);
    if (users.length === 0) return null;
    const userUid = users[0].uid;

    // Build scheduled datetime from appointment_date + appointment_time
    const apptDate = appointment.appointment_date;
    const apptTime = appointment.appointment_time;
    if (!apptDate || !apptTime) return null;

    const dateStr = apptDate instanceof Date ? apptDate.toISOString().split('T')[0] : String(apptDate).split('T')[0];
    const scheduledDt = new Date(`${dateStr}T${apptTime}:00`);
    const now = new Date();
    const diffMin = Math.abs(now - scheduledDt) / 60000;

    if (diffMin <= 15) {
      return await awardPoints(userUid, {
        activityType: 'APPOINTMENT_ON_TIME',
        activityRefId: String(appointment.id),
        points: 25,
        description: 'On-time appointment bonus',
      }, apptTenantId);
    }

    return null;
  } catch (err) {
    logger.warn('awardOnTimeBonus error', { error: err.message });
    return null;
  }
}

// ── Appointment streak check ──────────────────────────────────────────────────

export async function checkAppointmentStreak(userUid, tenantId = null) {
  try {
    // CAN-019: scope the appointment streak window (and the phone subquery) to
    // the user's tenant when resolvable — a phone is unique only per tenant.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM appointments
       WHERE phone = (SELECT phone FROM users WHERE uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''} LIMIT 1)${tenantId ? ' AND tenant_id = $2::uuid' : ''}
       ORDER BY appointment_date DESC, appointment_time DESC
       LIMIT 10`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );

    // Count consecutive COMPLETED from most recent
    let streak = 0;
    for (const row of rows) {
      if (row.status === 'COMPLETED') {
        streak++;
      } else {
        break;
      }
    }

    // 3-appointment streak: 100 pts
    if (streak >= 3 && rows[2]) {
      await awardPoints(userUid, {
        activityType: 'APPOINTMENT_STREAK',
        activityRefId: String(rows[2].id),
        points: 100,
        description: '3 consecutive completed appointments streak bonus',
      }, tenantId);
    }

    // 6-appointment streak: 250 pts
    if (streak >= 6 && rows[5]) {
      await awardPoints(userUid, {
        activityType: 'APPOINTMENT_STREAK_6',
        activityRefId: String(rows[5].id),
        points: 250,
        description: '6 consecutive completed appointments streak bonus',
      }, tenantId);
    }
  } catch (err) {
    logger.warn('checkAppointmentStreak error', { error: err.message });
  }
}

// ── Daily vitals log: 10 pts ──────────────────────────────────────────────────

export async function awardVitalsPoints(userUid, tenantId = null) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const activityRefId = `${userUid}:${today}`;

    const result = await awardPoints(userUid, {
      activityType: 'VITALS_LOG',
      activityRefId,
      points: 10,
      description: 'Daily vitals log recorded',
    }, tenantId);

    // Check 7-day vitals streak
    await checkVitalsStreak(userUid, tenantId);

    return result;
  } catch (err) {
    logger.warn('awardVitalsPoints error', { error: err.message });
    return null;
  }
}

async function checkVitalsStreak(userUid, tenantId = null) {
  try {
    // Count distinct days with VITALS_LOG in last 7 calendar days (CAN-012: tenant-scoped).
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT DATE(earned_at))::int AS day_count
       FROM health_point_ledger
       WHERE user_uid = $1::uuid
         AND activity_type = 'VITALS_LOG'
         AND earned_at >= NOW() - INTERVAL '7 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );

    const dayCount = rows[0]?.day_count || 0;
    if (dayCount >= 7) {
      const weekId = new Date().toISOString().split('T')[0]; // use today as ref
      await awardPoints(userUid, {
        activityType: 'VITALS_STREAK_7',
        activityRefId: `${userUid}:week:${weekId}`,
        points: 50,
        description: '7-day vitals logging streak bonus',
      }, tenantId);
    }
  } catch (err) {
    logger.warn('checkVitalsStreak error', { error: err.message });
  }
}

// ── Step daily goal: 15 pts ───────────────────────────────────────────────────

export async function awardStepPoints(userUid, dailyGoal, tenantId = null) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Get today's total steps (CAN-012: tenant-scoped when resolvable).
    // NOTE: reward-eligibility attestation is intentionally NOT filtered on
    // `source <> 'manual'` here — in this codebase the in-app pedometer walk
    // (/steps/session/*) writes rows with the schema-default source='manual', so
    // excluding 'manual' would silently break the primary legitimate earning
    // path (the device-sensor walk session that immediately calls this function).
    // A correct attestation needs a real "device-measured vs user-declared"
    // signal, not the source='manual' proxy — tracked as a separate design task.
    const stepRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(steps), 0)::int AS total_steps
       FROM step_sessions
       WHERE user_uid = $1::uuid
         AND is_active = false
         AND DATE(started_at AT TIME ZONE 'UTC') = $2::date${tenantId ? ' AND tenant_id = $3::uuid' : ''}`,
      ...(tenantId ? [userUid, today, tenantId] : [userUid, today])
    );

    const totalSteps = stepRows[0]?.total_steps || 0;
    if (totalSteps < dailyGoal) return null;

    const result = await awardPoints(userUid, {
      activityType: 'STEP_DAILY_GOAL',
      activityRefId: today,
      points: 15,
      description: `Daily step goal achieved (${totalSteps} steps)`,
    }, tenantId);

    // Check 7-day and 30-day streaks
    await checkStepStreaks(userUid, tenantId);

    return result;
  } catch (err) {
    logger.warn('awardStepPoints error', { error: err.message });
    return null;
  }
}

async function checkStepStreaks(userUid, tenantId = null) {
  try {
    // CAN-012: tenant-scope the streak ledger reads when resolvable.
    // Count distinct days with STEP_DAILY_GOAL in last 7 days
    const rows7 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT activity_ref_id)::int AS day_count
       FROM health_point_ledger
       WHERE user_uid = $1::uuid
         AND activity_type = 'STEP_DAILY_GOAL'
         AND earned_at >= NOW() - INTERVAL '7 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );

    if ((rows7[0]?.day_count || 0) >= 7) {
      const weekId = new Date().toISOString().split('T')[0];
      await awardPoints(userUid, {
        activityType: 'STEP_STREAK_7',
        activityRefId: `week:${weekId}`,
        points: 75,
        description: '7-day step goal streak bonus',
      }, tenantId);
    }

    // Count distinct days with STEP_DAILY_GOAL in last 30 days
    const rows30 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT activity_ref_id)::int AS day_count
       FROM health_point_ledger
       WHERE user_uid = $1::uuid
         AND activity_type = 'STEP_DAILY_GOAL'
         AND earned_at >= NOW() - INTERVAL '30 days'${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );

    if ((rows30[0]?.day_count || 0) >= 30) {
      const monthId = new Date().toISOString().substring(0, 7); // YYYY-MM
      await awardPoints(userUid, {
        activityType: 'STEP_STREAK_30',
        activityRefId: `month:${monthId}`,
        points: 200,
        description: '30-day step goal streak bonus',
      }, tenantId);
    }
  } catch (err) {
    logger.warn('checkStepStreaks error', { error: err.message });
  }
}

// ── User point summary ────────────────────────────────────────────────────────

export async function getUserPointSummary(userUid, tenantId = null) {
  try {
    // CAN-012: scope the per-user ledger/claim reads to the caller's tenant when
    // resolvable (health_milestones is a global catalog with no tenant_id, so it
    // is intentionally left unscoped).
    const totalRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(points), 0)::int AS total_points
       FROM health_point_ledger
       WHERE user_uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    const totalPoints = totalRows[0]?.total_points || 0;

    // All active milestones ordered by sort_order
    const milestones = await prisma.$queryRawUnsafe(
      `SELECT id, name, points_required, reward_type, reward_value,
              reward_description, icon_name, color_hex, sort_order
       FROM health_milestones
       WHERE is_active = true
       ORDER BY sort_order ASC, points_required ASC`
    );

    // Determine current tier (highest milestone achieved) and next tier
    let currentTier = null;
    let nextTier = null;
    for (const m of milestones) {
      if (totalPoints >= m.points_required) {
        currentTier = m;
      } else {
        if (!nextTier) nextTier = m;
      }
    }

    // Count unclaimed milestones (user has enough points but hasn't claimed)
    const unclaimedRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
       FROM health_milestones hm
       WHERE hm.is_active = true
         AND hm.points_required <= $1
         AND NOT EXISTS (
           SELECT 1 FROM health_milestone_claims hmc
           WHERE hmc.milestone_id = hm.id AND hmc.user_uid = $2::uuid${tenantId ? ' AND hmc.tenant_id = $3::uuid' : ''}
         )`,
      ...(tenantId ? [totalPoints, userUid, tenantId] : [totalPoints, userUid])
    );
    const unclaimedCount = unclaimedRows[0]?.count || 0;

    // Active vouchers (not redeemed, not expired)
    const vouchers = await prisma.$queryRawUnsafe(
      `SELECT hmc.id, hmc.voucher_code, hmc.claimed_at, hmc.expires_at,
              hm.name AS milestone_name, hm.reward_description
       FROM health_milestone_claims hmc
       JOIN health_milestones hm ON hm.id = hmc.milestone_id
       WHERE hmc.user_uid = $1::uuid
         AND hmc.is_redeemed = false
         AND hmc.expires_at > NOW()${tenantId ? ' AND hmc.tenant_id = $2::uuid' : ''}
       ORDER BY hmc.claimed_at DESC`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );

    // Recent 5 point entries
    const recentEntries = await prisma.$queryRawUnsafe(
      `SELECT id, points, activity_type, description, earned_at
       FROM health_point_ledger
       WHERE user_uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''}
       ORDER BY earned_at DESC
       LIMIT 5`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );

    return {
      totalPoints,
      currentTier: currentTier ? {
        id: currentTier.id,
        name: currentTier.name,
        pointsRequired: currentTier.points_required,
        iconName: currentTier.icon_name,
        colorHex: currentTier.color_hex,
      } : null,
      nextTier: nextTier ? {
        id: nextTier.id,
        name: nextTier.name,
        pointsRequired: nextTier.points_required,
        pointsNeeded: nextTier.points_required - totalPoints,
        progress: nextTier.points_required > 0
          ? Math.min(1, totalPoints / nextTier.points_required)
          : 1,
        iconName: nextTier.icon_name,
        colorHex: nextTier.color_hex,
      } : null,
      unclaimedCount,
      activeVouchers: vouchers,
      recentActivity: recentEntries,
    };
  } catch (err) {
    logger.warn('getUserPointSummary error', { error: err.message });
    throw err;
  }
}

// ── Next visit progress ───────────────────────────────────────────────────────

export async function getNextVisitProgress(phone, tenantId = null) {
  try {
    // CAN-019: scope by tenant when resolvable — a phone is unique only per
    // tenant (mig 333), so an unscoped phone match could surface another
    // tenant's appointments.
    // Last COMPLETED appointment
    const lastRows = await prisma.$queryRawUnsafe(
      `SELECT id, appointment_date, appointment_time, doctor_name, status
       FROM appointments
       WHERE phone = $1 AND status = 'COMPLETED'${tenantId ? ' AND tenant_id = $2::uuid' : ''}
       ORDER BY appointment_date DESC, appointment_time DESC
       LIMIT 1`,
      ...(tenantId ? [phone, tenantId] : [phone])
    );

    // Next SCHEDULED/CONFIRMED appointment
    const nextRows = await prisma.$queryRawUnsafe(
      `SELECT id, appointment_date, appointment_time, doctor_name, status
       FROM appointments
       WHERE phone = $1 AND status IN ('SCHEDULED', 'CONFIRMED')
         AND appointment_date >= CURRENT_DATE${tenantId ? ' AND tenant_id = $2::uuid' : ''}
       ORDER BY appointment_date ASC, appointment_time ASC
       LIMIT 1`,
      ...(tenantId ? [phone, tenantId] : [phone])
    );

    const lastAppt = lastRows[0] || null;
    const nextAppt = nextRows[0] || null;

    if (!nextAppt) {
      return {
        lastAppointment: lastAppt,
        nextAppointment: null,
        daysUntil: null,
        totalDaysBetween: null,
        progressFraction: null,
      };
    }

    const now = new Date();
    const nextDate = new Date(nextAppt.appointment_date);
    const today = new Date(now.toISOString().split('T')[0]);

    const daysUntil = Math.max(0, Math.ceil((nextDate - today) / 86400000));

    let totalDaysBetween = null;
    let progressFraction = null;

    if (lastAppt) {
      const lastDate = new Date(lastAppt.appointment_date);
      totalDaysBetween = Math.max(1, Math.ceil((nextDate - lastDate) / 86400000));
      const elapsed = Math.ceil((today - lastDate) / 86400000);
      progressFraction = Math.min(1, Math.max(0, elapsed / totalDaysBetween));
    } else {
      // No previous appointment — assume 30-day window
      totalDaysBetween = 30;
      progressFraction = Math.min(1, Math.max(0, (30 - daysUntil) / 30));
    }

    // Handle overdue (past the next appointment date)
    if (daysUntil === 0) {
      progressFraction = 1.0;
    }

    return {
      lastAppointment: lastAppt,
      nextAppointment: nextAppt,
      daysUntil,
      totalDaysBetween,
      progressFraction,
    };
  } catch (err) {
    logger.warn('getNextVisitProgress error', { error: err.message });
    return null;
  }
}

// ── Claim milestone ───────────────────────────────────────────────────────────

export async function claimMilestone(userUid, milestoneId, tenantId = null) {
  try {
    // Get milestone (health_milestones is a global catalog — no tenant_id).
    const milestoneRows = await prisma.$queryRawUnsafe(
      `SELECT id, name, points_required, reward_type, reward_value,
              reward_description, is_active
       FROM health_milestones
       WHERE id = $1`,
      parseInt(milestoneId, 10)
    );

    if (milestoneRows.length === 0) {
      return { error: 'Milestone not found', status: 404 };
    }

    const milestone = milestoneRows[0];
    if (!milestone.is_active) {
      return { error: 'Milestone is no longer active', status: 400 };
    }

    // Verify user has enough points (CAN-012: tenant-scoped ledger total).
    const totalRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(points), 0)::int AS total_points
       FROM health_point_ledger
       WHERE user_uid = $1::uuid${tenantId ? ' AND tenant_id = $2::uuid' : ''}`,
      ...(tenantId ? [userUid, tenantId] : [userUid])
    );
    const totalPoints = totalRows[0]?.total_points || 0;

    if (totalPoints < milestone.points_required) {
      return { error: 'Insufficient points to claim this milestone', status: 400 };
    }

    // Generate voucher code and insert claim. CAN-012: stamp tenant_id explicitly
    // so the claim is correctly attributed even outside an RLS context.
    const voucherCode = generateVoucherCode();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90); // 90-day expiry

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO health_milestone_claims (user_uid, milestone_id, voucher_code, expires_at${tenantId ? ', tenant_id' : ''})
       VALUES ($1::uuid, $2, $3, $4${tenantId ? ', $5::uuid' : ''})
       RETURNING id, voucher_code, claimed_at, expires_at`,
      ...(tenantId ? [userUid, milestone.id, voucherCode, expiresAt, tenantId] : [userUid, milestone.id, voucherCode, expiresAt])
    );

    if (claimRows.length === 0) {
      return { error: 'Failed to create claim', status: 500 };
    }

    return {
      claim: claimRows[0],
      milestone: {
        id: milestone.id,
        name: milestone.name,
        rewardType: milestone.reward_type,
        rewardValue: milestone.reward_value,
        rewardDescription: milestone.reward_description,
      },
    };
  } catch (err) {
    // Unique constraint = already claimed
    if (err.code === 'P2002' || (err.message && err.message.includes('unique'))) {
      return { error: 'Milestone already claimed', status: 409 };
    }
    logger.warn('claimMilestone error', { error: err.message, userUid, milestoneId });
    throw err;
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function generateVoucherCode() {
  return 'VH-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
