// src/services/investigation/orderService.js
// Investigation order service — aligned to the canonical `investigations` DB schema:
// - `requested_by` uuid (NOT `doctor_id`)
// - `test_type` (NOT `type`)
// - `requested_at` (NOT `ordered_date`)
// - status default 'REQUESTED' (the DB default), then 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'.

import { randomUUID } from 'node:crypto';
import {
  INVESTIGATION_TYPES,
  PRIORITY_LEVELS,
} from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// Subset of investigations columns the caller gets back. Shared between the
// clinical + legacy paths so the API surface stays consistent.
const INVESTIGATION_SELECT = {
  id: true,
  uid: true,
  phone: true,
  patient_id: true,
  test_name: true,
  test_type: true,
  status: true,
  priority: true,
  file_key: true,
  requested_by: true,
  requested_at: true,
  updated_at: true,
  turnaround_target_hours: true,
};

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

  // Prisma ORM — column names checked at runtime against schema.prisma so a
  // typo like `.findUnique({ where: { user_id: ... } })` fails loudly.
  const patient = await prisma.users.findUnique({
    where: { id: parseInt(patient_id) },
    select: { id: true, name: true, phone: true },
  });
  if (!patient) throw new Error('PATIENT_NOT_FOUND');

  const requesterUuid = doctor_uid || orderedBy;
  const now = new Date();

  const investigation = await prisma.investigations.create({
    data: {
      phone: patient.phone || 'unknown',
      patient_id: parseInt(patient_id),
      test_name,
      test_type: type.toUpperCase(),
      status: 'REQUESTED',
      priority: priority.toUpperCase(),
      requested_by: requesterUuid,
      updated_at: now,
    },
    select: INVESTIGATION_SELECT,
  });

  // Notification is best-effort. uid is populated client-side via randomUUID
  // (matches the legacy gen_random_uuid() behavior but avoids the DB
  // round-trip Prisma can't model via @default).
  await prisma.notifications.create({
    data: {
      uid: randomUUID(),
      phone: patient.phone || 'unknown',
      title: 'New Investigation Ordered',
      body: `Your doctor has ordered: ${test_name}. Please check your appointments.`,
      type: 'investigation_ordered',
      is_read: false,
      updated_at: now,
    },
  }).catch((err) => logger.warn(`investigation notification insert failed: ${err.message}`));

  if (notes) logger.info(`Investigation notes captured (not persisted — schema lacks notes col): ${notes.slice(0, 40)}…`);
  logger.info(`Investigation ordered: ${test_name} for patient ${patient_id} by ${requesterUuid}`);

  return {
    investigation,
    patient_name: patient.name,
  };
};

export const createLegacyInvestigation = async ({ phone, test_name, file_key, createdBy }) => {
  const now = new Date();
  const investigation = await prisma.investigations.create({
    data: {
      phone,
      test_name,
      file_key: file_key ?? null,
      status: 'REQUESTED',
      requested_by: createdBy ?? null,
      updated_at: now,
    },
    select: {
      id: true,
      phone: true,
      test_name: true,
      file_key: true,
      status: true,
      requested_by: true,
      requested_at: true,
    },
  });

  await prisma.notifications.create({
    data: {
      uid: randomUUID(),
      phone,
      title: 'Investigation Report Ready',
      body: `Your investigation report for "${test_name}" is now available.`,
      type: 'investigation_ready',
      is_read: false,
      updated_at: now,
    },
  }).catch((err) => logger.warn(`legacy investigation notification failed: ${err.message}`));

  logger.info(`Legacy investigation created: ${test_name} for ${phone}`);
  return investigation;
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN', 'SUPER_ADMIN'].includes(userRole);
};
