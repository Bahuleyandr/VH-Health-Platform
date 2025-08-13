// src/routes/admin/services/statsService.js
import { tableExists, columnExists, safeQuery, safeScalar } from './common.js';

/* ------------------------------- User stats ------------------------------- */
export async function getUserStats() {
  if (!(await tableExists('users'))) {
    return { total: 0, active: 0, newToday: 0, growth: [] };
  }

  const total = await safeScalar(`SELECT COUNT(*) FROM users`);
  const active = (await columnExists('users', 'is_active'))
    ? await safeScalar(`SELECT COUNT(*) FROM users WHERE is_active = true`)
    : 0;
  const newToday = (await columnExists('users', 'created_at'))
    ? await safeScalar(
        `SELECT COUNT(*) FROM users WHERE (created_at)::date = CURRENT_DATE`
      )
    : 0;

  const growth = (await columnExists('users', 'created_at'))
    ? await safeQuery(
        `
        SELECT date_trunc('day', created_at) AS date, COUNT(*)::int AS count
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1
        `,
        [],
        'users.growth'
      )
    : [];

  return { total, active, newToday, growth };
}

/* ------------------------------ Doctor stats ------------------------------ */
export async function getDoctorStats() {
  if (!(await tableExists('doctors'))) return { total: 0, available: 0, onDuty: 0 };

  const total = await safeScalar(`SELECT COUNT(*) FROM doctors`);
  const available = (await columnExists('doctors', 'is_available'))
    ? await safeScalar(`SELECT COUNT(*) FROM doctors WHERE is_available = true`)
    : 0;
  const onDuty = (await columnExists('doctors', 'is_on_leave'))
    ? await safeScalar(
        `SELECT COUNT(*) FROM doctors WHERE COALESCE(is_on_leave,false) = false`
      )
    : 0;

  return { total, available, onDuty };
}

/* ---------------------------- Department stats ---------------------------- */
export async function getDepartmentStats() {
  if (!(await tableExists('departments'))) return { total: 0, utilization: [] };

  const total = await safeScalar(`SELECT COUNT(*) FROM departments`);
  const names = await safeQuery(
    `SELECT name FROM departments ORDER BY name LIMIT 20`,
    [],
    'depts.names'
  );

  return {
    total,
    utilization: names.map((r) => ({
      name: r.name,
      patientCount: null,
      utilization: null,
    })),
  };
}

/* --------------------------- Appointment stats ---------------------------- */
export async function getAppointmentStats() {
  if (!(await tableExists('appointments'))) {
    return {
      today: 0,
      upcoming: 0,
      completed: 0,
      no_shows: 0,
      completionRate: 0,
      trends: [],
      avg_wait_time_minutes: null,
    };
  }

  const core = await safeQuery(
    `
    SELECT
      COUNT(*) FILTER (WHERE (appointment_date)::date = CURRENT_DATE)::int AS today,
      COUNT(*) FILTER (WHERE status = 'scheduled' AND appointment_date > NOW())::int AS upcoming,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
      COUNT(*)::int AS total
    FROM appointments
    `,
    [],
    'appts.core'
  );
  const r = core[0] || {
    today: 0,
    upcoming: 0,
    completed: 0,
    no_shows: 0,
    total: 0,
  };

  const trends = await safeQuery(
    `
    SELECT (appointment_date)::date AS date,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
    FROM appointments
    WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY 1
    `,
    [],
    'appts.trends'
  );

  const wait = await safeQuery(
    `
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(updated_at, appointment_date) - appointment_date)) / 60))::int AS minutes
    FROM appointments
    WHERE status = 'completed'
      AND (appointment_date)::date = CURRENT_DATE
    `,
    [],
    'appts.wait'
  );

  const completionRate =
    r.total > 0 ? Math.round((r.completed * 10000) / r.total) / 100 : 0;

  return {
    today: r.today ?? 0,
    upcoming: r.upcoming ?? 0,
    completed: r.completed ?? 0,
    no_shows: r.no_shows ?? 0,
    completionRate,
    trends,
    avg_wait_time_minutes: wait[0]?.minutes ?? null,
  };
}

/* ------------------------------ Record stats ------------------------------ */
export async function getRecordStats() {
  if (!(await tableExists('medical_records')))
    return { total: 0, createdToday: 0 };

  const rows = await safeQuery(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE (created_at)::date = CURRENT_DATE)::int AS createdtoday
    FROM medical_records
    `,
    [],
    'records.core'
  );
  return { total: rows[0]?.total ?? 0, createdToday: rows[0]?.createdtoday ?? 0 };
}

/* ----------------------------- Emergency stats ---------------------------- */
export async function getEmergencyStats() {
  if (!(await tableExists('sos_alerts'))) return { active: 0, last24Hours: 0 };

  const rows = await safeQuery(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '24 hours')::int AS last24hours
    FROM sos_alerts
    `,
    [],
    'sos.core'
  );
  return { active: rows[0]?.active ?? 0, last24Hours: rows[0]?.last24hours ?? 0 };
}

/* ------------------------------- Staff stats ------------------------------ */
export async function getStaffStats() {
  if (!(await tableExists('staff'))) {
    return {
      total_staff: 0,
      active_staff: 0,
      on_leave: 0,
      present_today: 0,
      pending_reviews: 0,
      pending_leaves: 0,
    };
  }

  const core = await safeQuery(
    `
    SELECT
      COUNT(*)::int AS total_staff,
      COUNT(*) FILTER (WHERE COALESCE(is_active, true) = true)::int AS active_staff,
      COUNT(*) FILTER (WHERE COALESCE(on_leave, false) = true)::int AS on_leave
    FROM staff
    `,
    [],
    'staff.core'
  );

  const present = (await tableExists('staff_attendance'))
    ? await safeQuery(
        `
        SELECT COUNT(DISTINCT staff_id)::int AS present_today
        FROM staff_attendance
        WHERE (check_in_time)::date = CURRENT_DATE
        `,
        [],
        'staff.present'
      )
    : [{ present_today: 0 }];

  const pendingReviews = (await tableExists('performance_reviews'))
    ? await safeQuery(
        `SELECT COUNT(*)::int AS c FROM performance_reviews WHERE status = 'pending'`,
        [],
        'staff.reviews'
      )
    : [{ c: 0 }];

  const pendingLeaves = (await tableExists('leave_applications'))
    ? await safeQuery(
        `SELECT COUNT(*)::int AS c FROM leave_applications WHERE status = 'pending'`,
        [],
        'staff.leaves'
      )
    : [{ c: 0 }];

  return {
    total_staff: core[0]?.total_staff ?? 0,
    active_staff: core[0]?.active_staff ?? 0,
    on_leave: core[0]?.on_leave ?? 0,
    present_today: present[0]?.present_today ?? 0,
    pending_reviews: pendingReviews[0]?.c ?? 0,
    pending_leaves: pendingLeaves[0]?.c ?? 0,
  };
}

/* ------------------------------- Quick stats ------------------------------ */
export async function getQuickStats() {
  const [appointments, users, staff, revenue] = await Promise.all([
    (async () => {
      if (!(await tableExists('appointments'))) return { today: 0, week: 0 };
      const today = await safeScalar(
        `SELECT COUNT(*) FROM appointments WHERE appointment_date::date = CURRENT_DATE`
      );
      const week = await safeScalar(
        `SELECT COUNT(*) FROM appointments WHERE appointment_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'`
      );
      return { today, week };
    })(),
    (async () => {
      if (!(await tableExists('users'))) return { total: 0, active: 0 };
      const total = await safeScalar(`SELECT COUNT(*) FROM users`);
      const active = (await columnExists('users', 'is_active'))
        ? await safeScalar(`SELECT COUNT(*) FROM users WHERE is_active = true`)
        : 0;
      return { total, active };
    })(),
    (async () => {
      if (!(await tableExists('staff'))) return { total: 0, present: 0 };
      const total = await safeScalar(`SELECT COUNT(*) FROM staff`);
      const present = (await tableExists('staff_attendance'))
        ? await safeScalar(
            `SELECT COUNT(*) FROM staff_attendance WHERE check_in_time::date = CURRENT_DATE`
          )
        : 0;
      return { total, present };
    })(),
    (async () => {
      if (!(await tableExists('pharmacy_orders'))) return { today: 0, month: 0 };
      const today = await safeScalar(
        `SELECT COALESCE(SUM(total_amount),0) FROM pharmacy_orders WHERE DATE(placed_at) = CURRENT_DATE`
      );
      const month = await safeScalar(
        `SELECT COALESCE(SUM(total_amount),0) FROM pharmacy_orders WHERE placed_at >= DATE_TRUNC('month', CURRENT_DATE)`
      );
      return { today: Number(today), month: Number(month) };
    })(),
  ]);

  return { appointments, users, staff, revenue };
}

/* ------------------------- Appointments: summary card --------------------- */
export async function getAppointmentSummary() {
  if (!(await tableExists('appointments'))) {
    return {
      today_total: 0,
      today_scheduled: 0,
      today_completed: 0,
      upcoming_total: 0,
      total_no_shows: 0,
      unique_patients: 0,
      active_doctors: 0,
      avg_wait_time_minutes: null,
    };
  }

  const rows = await safeQuery(
    `
    SELECT 
      COUNT(*) FILTER (WHERE appointment_date::date = CURRENT_DATE)::int as today_total,
      COUNT(*) FILTER (WHERE appointment_date::date = CURRENT_DATE AND status = 'scheduled')::int as today_scheduled,
      COUNT(*) FILTER (WHERE appointment_date::date = CURRENT_DATE AND status = 'completed')::int as today_completed,
      COUNT(*) FILTER (WHERE appointment_date > NOW() AND status = 'scheduled')::int as upcoming_total,
      COUNT(*) FILTER (WHERE appointment_date < NOW() AND status = 'no_show')::int as total_no_shows,
      COUNT(DISTINCT patient_id)::int as unique_patients,
      COUNT(DISTINCT doctor_id)::int as active_doctors,
      ROUND(AVG(CASE WHEN status = 'completed' THEN 
        EXTRACT(EPOCH FROM (updated_at - appointment_date))/60 
      END))::int as avg_wait_time_minutes
    FROM appointments
    WHERE appointment_date >= CURRENT_DATE - INTERVAL '30 days'
    `,
    [],
    'appts.summary'
  );

  // Ensure all keys exist with numbers (or null for avg)
  const r = rows[0] || {};
  return {
    today_total: r.today_total ?? 0,
    today_scheduled: r.today_scheduled ?? 0,
    today_completed: r.today_completed ?? 0,
    upcoming_total: r.upcoming_total ?? 0,
    total_no_shows: r.total_no_shows ?? 0,
    unique_patients: r.unique_patients ?? 0,
    active_doctors: r.active_doctors ?? 0,
    avg_wait_time_minutes:
      typeof r.avg_wait_time_minutes === 'number' ? r.avg_wait_time_minutes : null,
  };
}

export default {
  getUserStats,
  getDoctorStats,
  getDepartmentStats,
  getAppointmentStats,
  getRecordStats,
  getEmergencyStats,
  getStaffStats,
  getQuickStats,
  getAppointmentSummary,
};
