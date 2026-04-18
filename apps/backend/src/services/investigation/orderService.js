// src/services/investigation/orderService.js
// Investigation order service — aligned to the canonical `investigations` DB schema:
// - `requested_by` uuid (NOT `doctor_id`)
// - `test_type` (NOT `type`)
// - `requested_at` (NOT `ordered_date`)
// - status default 'REQUESTED' (the DB default), then 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'.

import {
  INVESTIGATION_TYPES,
  PRIORITY_LEVELS,
} from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const INVESTIGATION_RETURNING = `id, uid, phone, patient_id, test_name, test_type, status,
    priority, file_key, requested_by, requested_at, updated_at, turnaround_target_hours`;

export const createInvestigationOrder = async (orderData) => {
  const {
    patient_id, doctor_uid, test_name, type,
    priority = 'NORMAL', notes, orderedBy,
  } = orderData;

  if (!patient_id || !(doctor_uid || orderedBy) || !test_name || !type) {
    throw new Error('MISSING_REQUIRED_FIELDS');
  }
  if (!Object.values(INVESTIGATION_TYPES).includes(type.toUpperCase())) {
    throw new Error('INVALID_TYPE');
  }
  if (!Object.values(PRIORITY_LEVELS).includes(priority.toUpperCase())) {
    throw new Error('INVALID_PRIORITY');
  }

  const [patientRows] = await Promise.all([
    prisma.$queryRaw`SELECT id, name, phone FROM users WHERE id = ${parseInt(patient_id)}`,
  ]);
  if (patientRows.length === 0) throw new Error('PATIENT_NOT_FOUND');
  const patient = patientRows[0];

  const requesterUuid = doctor_uid || orderedBy;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations (
        phone, patient_id, test_name, test_type, status, priority,
        requested_by, requested_at, updated_at
     ) VALUES (
        $1, $2, $3, $4, 'REQUESTED', $5, $6::uuid, NOW(), NOW()
     )
     RETURNING ${INVESTIGATION_RETURNING}`,
    patient.phone || 'unknown',
    parseInt(patient_id),
    test_name,
    type.toUpperCase(),
    priority.toUpperCase(),
    requesterUuid,
  );

  // Notification is best-effort (use the legacy path for PATIENT notification)
  await prisma.$queryRawUnsafe(
    `INSERT INTO notifications (phone, title, body, type, created_at, updated_at, uid, is_read)
     VALUES ($1, 'New Investigation Ordered', $2, 'investigation_ordered', NOW(), NOW(), gen_random_uuid(), false)`,
    patient.phone || 'unknown',
    `Your doctor has ordered: ${test_name}. Please check your appointments.`,
  ).catch((err) => logger.warn(`investigation notification insert failed: ${err.message}`));

  if (notes) logger.info(`Investigation notes captured (not persisted — schema lacks notes col): ${notes.slice(0, 40)}…`);
  logger.info(`Investigation ordered: ${test_name} for patient ${patient_id} by ${requesterUuid}`);

  return {
    investigation: rows[0],
    patient_name: patient.name,
  };
};

export const createLegacyInvestigation = async ({ phone, test_name, file_key, createdBy }) => {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations (phone, test_name, file_key, status, requested_by, requested_at, updated_at)
     VALUES ($1, $2, $3, 'REQUESTED', $4::uuid, NOW(), NOW())
     RETURNING id, phone, test_name, file_key, status, requested_by, requested_at`,
    phone, test_name, file_key ?? null, createdBy ?? null,
  );

  await prisma.$queryRawUnsafe(
    `INSERT INTO notifications (phone, title, body, type, created_at, updated_at, uid, is_read)
     VALUES ($1, 'Investigation Report Ready', $2, 'investigation_ready', NOW(), NOW(), gen_random_uuid(), false)`,
    phone,
    `Your investigation report for "${test_name}" is now available.`,
  ).catch((err) => logger.warn(`legacy investigation notification failed: ${err.message}`));

  logger.info(`Legacy investigation created: ${test_name} for ${phone}`);
  return rows[0];
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN', 'SUPER_ADMIN'].includes(userRole);
};
