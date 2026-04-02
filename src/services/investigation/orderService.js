// src/services/investigation/orderService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import {
  INVESTIGATION_TYPES,
  PRIORITY_LEVELS
} from '../../config/investigationConfig.js';
import logger from '../../logging/logger.js';

export const createInvestigationOrder = async (orderData) => {
  const {
    patient_id, doctor_id, test_name, test_code, type, priority = 'NORMAL',
    scheduled_date, notes, normal_range, unit, cost, orderedBy
  } = orderData;

  if (!patient_id || !doctor_id || !test_name || !type) {
    throw new Error('MISSING_REQUIRED_FIELDS');
  }

  if (!Object.values(INVESTIGATION_TYPES).includes(type.toUpperCase())) {
    throw new Error('INVALID_TYPE');
  }

  if (!Object.values(PRIORITY_LEVELS).includes(priority.toUpperCase())) {
    throw new Error('INVALID_PRIORITY');
  }

  // Verify patient and doctor exist
  const [patientRows, doctorRows] = await Promise.all([
    prisma.$queryRaw`SELECT id, name, phone FROM users WHERE id = ${parseInt(patient_id)}`,
    prisma.$queryRaw`SELECT id, name FROM users WHERE id = ${parseInt(doctor_id)} AND role = 'DOCTOR'`,
  ]);

  if (patientRows.length === 0) throw new Error('PATIENT_NOT_FOUND');
  if (doctorRows.length === 0) throw new Error('DOCTOR_NOT_FOUND');

  const patient = patientRows[0];
  const doctor = doctorRows[0];

  // Create investigation + notification atomically
  const [investigationRows] = await prisma.$transaction([
    prisma.$queryRaw`
      INSERT INTO investigations (
        patient_id, doctor_id, test_name, test_code, type, priority,
        scheduled_date, notes, normal_range, unit, cost, status,
        ordered_date, created_at, created_by
      ) VALUES (
        ${parseInt(patient_id)}, ${parseInt(doctor_id)}, ${test_name},
        ${test_code ?? null}, ${type.toUpperCase()}, ${priority.toUpperCase()},
        ${scheduled_date ?? null}, ${notes ?? null}, ${normal_range ?? null},
        ${unit ?? null}, ${cost ?? null}, 'PENDING', NOW(), NOW(), ${orderedBy ?? null}
      )
      RETURNING id, patient_id, doctor_id, test_name, test_code, type, priority,
        scheduled_date, notes, normal_range, unit, cost, status,
        ordered_date, created_at, created_by
    `,
    prisma.$queryRaw`
      INSERT INTO notifications (phone, title, body, type, created_at, uid, is_read)
      VALUES (
        ${patient.phone || 'unknown'},
        'New Investigation Ordered',
        ${'Your doctor has ordered: ' + test_name + '. Please check your appointments.'},
        'investigation_ordered',
        NOW(),
        gen_random_uuid(),
        false
      )
    `,
  ]);

  logger.info(`Investigation ordered: ${test_name} for patient ${patient_id} by ${orderedBy}`);

  return {
    investigation: investigationRows[0],
    patient_name: patient.name,
    doctor_name: doctor.name,
  };
};

export const createLegacyInvestigation = async ({ phone, test_name, file_key, createdBy }) => {
  const [rows] = await prisma.$transaction([
    prisma.$queryRaw`
      INSERT INTO investigations (phone, test_name, file_key, created_by)
      VALUES (${phone}, ${test_name}, ${file_key ?? null}, ${createdBy ?? null})
      RETURNING id, phone, test_name, file_key, status, created_by, created_at
    `,
    prisma.$queryRaw`
      INSERT INTO notifications (phone, title, body, type, created_at, uid, is_read)
      VALUES (
        ${phone},
        'Investigation Report Ready',
        ${'Your investigation report for "' + test_name + '" is now available.'},
        'investigation_ready',
        NOW(),
        gen_random_uuid(),
        false
      )
    `,
  ]);

  logger.info(`Legacy investigation created: ${test_name} for ${phone}`);
  return rows[0];
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN'].includes(userRole);
};
