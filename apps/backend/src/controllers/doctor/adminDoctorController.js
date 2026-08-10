// src/controllers/doctor/adminDoctorController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { adminDoctorService } from '../../services/doctor/adminDoctorService.js';
import { parseListQuery } from '../../utils/listQuery.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

export const adminDoctorController = {
  // Test endpoint
  test: (req, res) => {
    success(res, {
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      user: req.user?.role || 'anonymous'
    }, 'Admin doctor routes working!');
  },

  // Get doctor management overview
  getDoctorOverview: async (req, res) => {
    try {
      const overview = await adminDoctorService.getDoctorOverview();

      success(res, {
        overview,
        generated_at: new Date().toLocaleDateString('en-GB')
      }, 'Doctor management overview retrieved successfully');
    } catch (err) {
      logger.error('Error fetching doctor overview:', err);
      error(res, 'Failed to retrieve doctor overview');
    }
  },

  // Get doctor management list
  getDoctorManagementList: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, 'Validation error', 400, errors.array());
      }

      const listQuery = parseListQuery(req.query, {
        defaultLimit: 20,
        maxLimit: 100,
        defaultSortBy: 'name',
        defaultSortOrder: 'ASC',
        allowedSortFields: [
          'name',
          'department',
          'specialization',
          'status',
          'registered_at',
          'total_appointments',
          'recent_appointments'
        ]
      });

      const filters = {
        page: listQuery.page,
        limit: listQuery.limit,
        department: req.query.department,
        specialization: req.query.specialization,
        status: req.query.status,
        experience_min: req.query.experience_min,
        experience_max: req.query.experience_max,
        search: listQuery.search,
        sortBy: listQuery.sortBy,
        sortOrder: listQuery.sortOrder
      };

      const result = await adminDoctorService.getDoctorManagementList(filters);

      success(res, {
        doctors: result.doctors,
        pagination: result.pagination,
        filters: result.filters
      }, 'Doctor management data retrieved successfully');
    } catch (err) {
      logger.error('Error fetching doctor management list:', err);
      error(res, 'Failed to retrieve doctor management data');
    }
  },

  // Create doctor account
  createDoctorAccount: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, 'Validation error', 400, errors.array());
      }

      const result = await adminDoctorService.createDoctorAccount(req.body);

      logger.info(`[adminDoctorRoutes] Doctor account created: ${req.body.name} (${maskPhoneForLog(req.body.phone)}) by ${req.user?.uid}`);

      success(res, {
        user: result.user,
        doctor_profile: result.doctor_profile
      }, 'Doctor account created successfully', 201);
    } catch (err) {
      logger.error('Error creating doctor account:', err);

      if (err.message.includes('already exists')) {
        return error(res, err.message, 409);
      }

      error(res, 'Failed to create doctor account');
    }
  },

  // Bulk doctor operations
  performBulkOperations: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, 'Validation error', 400, errors.array());
      }

      const { operation, doctor_ids, data } = req.body;
      const result = await adminDoctorService.performBulkOperation(operation, doctor_ids, data);

      logger.info(`[adminDoctorRoutes] Bulk ${operation} performed on ${doctor_ids.length} doctors by ${req.user?.uid}`);

      success(res, result, `Bulk ${operation} operation completed successfully`);
    } catch (err) {
      logger.error('Error performing bulk operations:', err);
      return relayAppError(res, err, 'Failed to perform bulk operation');
    }
  },

  // Update doctor profile (admin)
  updateDoctorProfile: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, 'Validation error', 400, errors.array());
      }

      const { id } = req.params;

      // Verify doctor exists — also accepts doctors with no user row (legacy)
      const doctorCheck = await prisma.$queryRawUnsafe(
        'SELECT d.id, COALESCE(u.name, d.name) as name FROM doctors d LEFT JOIN users u ON u.id = d.user_id WHERE (d.user_id = $1 OR d.id = $1) AND d.is_active = true',
        parseInt(id)
      );

      if (doctorCheck.length === 0) {
        return error(res, 'Doctor not found', 404);
      }

      const doctorId = doctorCheck[0].id;

      // Update doctors table using the actual schema. Older API payloads may
      // include fee/schedule fields that are not present in this table.
      const result = await prisma.$queryRawUnsafe(`
        UPDATE doctors SET
          name = COALESCE($1, name),
          specialty = COALESCE($2, specialty),
          department = COALESCE($3, department),
          intro = COALESCE($4, intro),
          updated_at = NOW()
        WHERE id = $5
        RETURNING id, name, department, specialty, intro, image_url,
          NULL::numeric as consultation_fee,
          NULL::text[] as available_days,
          NULL::jsonb as available_hours,
          is_available, is_active, created_at
      `,
        req.body.name || null,
        req.body.specialization || null,
        req.body.department || null,
        req.body.bio || null,
        doctorId
      );

      // Also update users table for name/email/phone if user row exists
      if (req.body.email || req.body.phone || req.body.name) {
        await prisma.$queryRawUnsafe(`
          UPDATE users u SET
            name = COALESCE($1, u.name),
            email = COALESCE($2, u.email),
            phone = COALESCE($3, u.phone),
            updated_at = NOW()
          FROM doctors d
          WHERE u.id = d.user_id AND d.id = $4 AND d.user_id IS NOT NULL
        `, req.body.name || null, req.body.email || null, req.body.phone || null, doctorId);
      }

      logger.info(`[adminDoctorRoutes] Doctor profile updated: ${id} by ${req.user?.uid}`);

      success(res, {
        doctor: {
          ...result[0],
          name: doctorCheck[0].name
        }
      }, 'Doctor profile updated successfully');
    } catch (err) {
      logger.error('Error updating doctor profile:', err);
      error(res, 'Failed to update doctor profile');
    }
  },

  // Update doctor availability
  updateDoctorAvailability: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, 'Validation error', 400, errors.array());
      }

      const { id } = req.params;

      if (typeof req.body.is_available !== 'boolean') {
        return error(res, 'is_available must be a boolean value', 400);
      }

      const result = await adminDoctorService.updateDoctorAvailability(id, req.body);

      logger.info(`[adminDoctorRoutes] Doctor ${id} availability updated by ${req.user?.uid}`);

      success(res, result, 'Doctor availability updated successfully');
    } catch (err) {
      logger.error('Error updating doctor availability:', err);

      if (err.message === 'Doctor not found') {
        return error(res, 'Doctor not found', 404);
      }

      return relayAppError(res, err, 'Failed to update doctor availability');
    }
  },

  // Delete doctor account
  deleteDoctorAccount: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, 'Validation error', 400, errors.array());
      }

      const { id } = req.params;
      const result = await adminDoctorService.deleteDoctorAccount(id, req.body);

      logger.info(`[adminDoctorRoutes] Doctor account deleted: ${result.doctor.name} by ${req.user?.uid} (${result.appointments_handled.future_appointments} appointments handled)`);

      success(res, result, 'Doctor account deleted successfully');
    } catch (err) {
      logger.error('Error deleting doctor account:', err);

      if (err.message === 'Doctor not found') {
        return error(res, 'Doctor not found', 404);
      }

      if (err.message.includes('future appointments')) {
        return error(res, 'Cannot delete doctor with future appointments. Provide transfer_patients_to doctor ID or cancel appointments first', 400);
      }

      return relayAppError(res, err, 'Failed to delete doctor account');
    }
  },

  // Legacy endpoints
  addDoctor: async (req, res) => {
    try {
      const { name, department, intro, imageUrl } = req.body;
      
      if (!name || !department) {
        return error(res, 'Doctor name and department are required', HTTP_STATUS.BAD_REQUEST);
      }
      
      const result = await prisma.$queryRawUnsafe(
        `INSERT INTO doctors (name, department, intro, image_url, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, name, department, intro, image_url, is_active, created_at, updated_at`,
        name, department, intro, imageUrl
      );
      
      success(res, result[0], 'Doctor saved successfully');
    } catch (err) {
      logger.error(err.stack || err.toString());
      error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
    }
  },

  deleteDoctor: async (req, res) => {
    try {
      const { doctorId } = req.params;
      
      const deleteResult = await prisma.$queryRawUnsafe(
        'DELETE FROM doctors WHERE id = $1 RETURNING id, name, department, intro, image_url, is_active, created_at', doctorId);
      
      if (deleteResult.length === 0) {
        return error(res, 'Doctor not found or already deleted', HTTP_STATUS.NOT_FOUND);
      }
      
      logger.info(`[adminDoctorRoutes] Doctor deleted: ${doctorId} by ${req.user?.uid}`);
      success(res, deleteResult[0], 'Doctor deleted successfully');
    } catch (err) {
      logger.error(err.stack || err.toString());
      error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
    }
  }
};
