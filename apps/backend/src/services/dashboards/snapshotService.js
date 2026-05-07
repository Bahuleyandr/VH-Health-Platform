// src/services/dashboards/snapshotService.js
//
// Sprint 9 — direct (non-Metabase) snapshot queries for the admin
// portal's "today" widget. Hits the bi_* views from migration 157.

import prisma from '../../lib/prisma.js';

export async function getDailyOpsSnapshot() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM bi_daily_ops_snapshot`,
  );
  return rows[0] || null;
}

export async function getOpdDaily({ from, to, doctor_id }) {
  const fromD = from || new Date(Date.now() - 14 * 86400 * 1000).toISOString().split('T')[0];
  const toD = to || new Date().toISOString().split('T')[0];
  const params = [fromD, toD];
  let where = `d BETWEEN $1::date AND $2::date`;
  if (doctor_id) {
    params.push(Number(doctor_id));
    where += ` AND doctor_id = $${params.length}::int`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT * FROM bi_opd_daily WHERE ${where} ORDER BY d DESC, doctor_name`,
    ...params,
  );
}

export async function getIpOccupancy({ from, to, ward }) {
  const fromD = from || new Date(Date.now() - 14 * 86400 * 1000).toISOString().split('T')[0];
  const toD = to || new Date().toISOString().split('T')[0];
  const params = [fromD, toD];
  let where = `d BETWEEN $1::date AND $2::date`;
  if (ward) {
    params.push(ward);
    where += ` AND ward = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT * FROM bi_ip_occupancy_daily WHERE ${where} ORDER BY d DESC, ward`,
    ...params,
  );
}

export async function getDoctorProductivity30d() {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM bi_doctor_productivity_30d ORDER BY opd_appointments_30d DESC`,
  );
}

export async function getPayerMixMonthly({ months = 6 } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM bi_payer_mix_monthly
      WHERE month >= (CURRENT_DATE - ($1 || ' months')::interval)::date
      ORDER BY month DESC, claim_type, status`,
    String(Number(months)),
  );
}

export async function getLabTatSummary({ from, to }) {
  const fromD = from || new Date(Date.now() - 14 * 86400 * 1000).toISOString().split('T')[0];
  const toD = to || new Date().toISOString().split('T')[0];
  return prisma.$queryRawUnsafe(
    `SELECT * FROM bi_lab_tat_summary
      WHERE d BETWEEN $1::date AND $2::date
      ORDER BY d DESC`,
    fromD, toD,
  );
}
