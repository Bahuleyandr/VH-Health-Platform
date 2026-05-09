// src/controllers/doctor/doctorController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { doctorService } from '../../services/doctor/doctorService.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { success, error } from '../../utils/responseHelper.js';

export const doctorController = {
  // Test endpoint
  test: (req, res) => {
    success(res, { 
      message: 'Doctor routes working!',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      user: req.user?.name || 'Unknown'
    }, 'Doctor routes operational');
  },

  // Get all doctors
  getAllDoctors: async (req, res) => {
    try {
      const listQuery = parseListQuery(req.query, {
        defaultLimit: 10,
        maxLimit: 100,
        defaultSortBy: 'name',
        defaultSortOrder: 'ASC',
      });
      // Accept both `department` (free-text name) and `departmentId` (numeric
      // FK) so callers using either convention get the filter applied. The
      // previous implementation silently ignored departmentId, so receptionist
      // dropdowns showed every doctor in the system. See finding
      // 2026-05-08-walk-in-opd-receptionist-doctors-filter-ignores-departmentid.
      const departmentIdRaw = req.query.departmentId ?? req.query.department_id;
      const departmentId = departmentIdRaw != null && /^\d+$/.test(String(departmentIdRaw))
        ? parseInt(departmentIdRaw, 10)
        : null;
      const filters = {
        page: listQuery.page,
        limit: listQuery.limit,
        department: req.query.department,
        departmentId,
        available: req.query.available === undefined ? undefined : req.query.available === 'true',
        search: listQuery.search
      };

      const result = await doctorService.getAllDoctors(filters);

      success(res, {
        doctors: result.doctors,
        pagination: buildPagination(result.total, result.page, result.limit),
        filters: {
          department: filters.department || null,
          departmentId: filters.departmentId || null,
          available: filters.available || null,
          search: filters.search || null
        },
        requestedBy: req.user?.name
      }, 'Doctors retrieved successfully');
    } catch (err) {
      logger.error('Error fetching doctors:', err);
      error(res, 'Failed to retrieve doctors', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Get doctor by ID
  getDoctorById: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      // Route is mounted at `/:doctorId` (and `/profile/:id`); accept either
      // so the same controller works for both shapes without silently
      // looking up `undefined` and 404-ing.
      const identifier = req.params.doctorId ?? req.params.id;
      const doctor = await doctorService.getDoctorById(identifier);

      if (!doctor) {
        return error(res, 'Doctor not found', HTTP_STATUS.NOT_FOUND);
      }
      
      // Role-based data filtering
      if (req.user?.role === 'PATIENT') {
        delete doctor.phone;
        delete doctor.email;
        delete doctor.address;
        delete doctor.birthday;
      }
      
      success(res, {
        doctor,
        requestedBy: req.user?.name
      }, 'Doctor retrieved successfully');
    } catch (err) {
      logger.error('Error fetching doctor:', err);
      error(res, 'Failed to retrieve doctor', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Get doctors by department
  getDoctorsByDepartment: async (req, res) => {
    try {
      const { department } = req.params;
      const availableOnly = req.query.available_only === 'true';
      
      const doctors = await doctorService.getDoctorsByDepartment(department, availableOnly);
      
      // Filter sensitive information for patients
      const filteredDoctors = doctors.map(doctor => {
        if (req.user?.role === 'PATIENT') {
          const { phone, email, ...publicInfo } = doctor;
          return publicInfo;
        }
        return doctor;
      });
      
      success(res, {
        doctors: filteredDoctors,
        count: filteredDoctors.length,
        department: department.toUpperCase(),
        filters: { available_only: availableOnly },
        requestedBy: req.user?.name
      }, `Doctors in ${department} department retrieved successfully`);
    } catch (err) {
      logger.error('Error fetching doctors by department:', err);
      error(res, 'Failed to retrieve doctors by department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Get available doctors
  getAvailableDoctors: async (req, res) => {
    try {
      const result = await doctorService.getAvailableDoctors();
      
      // Filter sensitive information for patients
      const filteredDoctors = result.doctors.map(doctor => {
        if (req.user?.role === 'PATIENT') {
          const { phone, ...publicInfo } = doctor;
          return publicInfo;
        }
        return doctor;
      });
      
      success(res, {
        doctors: filteredDoctors,
        count: filteredDoctors.length,
        currentTime: result.currentTime,
        requestedBy: req.user?.name
      }, 'Available doctors retrieved successfully');
    } catch (err) {
      logger.error('Error fetching available doctors:', err);
      error(res, 'Failed to retrieve available doctors', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Create doctor profile
  createDoctorProfile: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      // Role-based access control
      if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(req.body.user_id)) {
        return error(res, 'Can only create profile for yourself', HTTP_STATUS.FORBIDDEN);
      }
      
      if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
        return error(res, 'Insufficient permissions to create doctor profile', HTTP_STATUS.FORBIDDEN);
      }
      
      const result = await doctorService.createDoctorProfile(req.body);
      
      logger.info(`Doctor profile created for ${result.user_name} by ${req.user?.name}`);
      
      success(res, {
        profile: result.profile,
        user_name: result.user_name,
        createdBy: req.user?.name
      }, 'Doctor profile created successfully', HTTP_STATUS.CREATED);
    } catch (err) {
      logger.error('Error creating doctor profile:', err);
      
      if (err.message === 'Doctor profile already exists') {
        return error(res, err.message, HTTP_STATUS.CONFLICT);
      }
      
      error(res, err.message || 'Failed to create doctor profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Update doctor profile
  updateDoctorProfile: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      const { id } = req.params;
      
      // Role-based access control
      if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(id)) {
        return error(res, 'Can only update your own profile', HTTP_STATUS.FORBIDDEN);
      }
      
      if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
        return error(res, 'Insufficient permissions to update doctor profile', HTTP_STATUS.FORBIDDEN);
      }
      
      const profile = await doctorService.updateDoctorProfile(id, req.body);
      
      logger.info(`Doctor profile updated for user ${id} by ${req.user?.name}`);
      
      success(res, {
        profile,
        updatedBy: req.user?.name
      }, 'Doctor profile updated successfully');
    } catch (err) {
      logger.error('Error updating doctor profile:', err);
      
      if (err.message === 'Doctor not found') {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      
      error(res, 'Failed to update doctor profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Update doctor availability
  updateDoctorAvailability: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      const { id } = req.params;
      
      // Role-based access control
      if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(id)) {
        return error(res, 'Can only update your own availability', HTTP_STATUS.FORBIDDEN);
      }
      
      if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
        return error(res, 'Insufficient permissions to update doctor availability', HTTP_STATUS.FORBIDDEN);
      }
      
      const availability = await doctorService.updateDoctorAvailability(id, req.body);
      
      logger.info(`Doctor availability updated for user ${id} by ${req.user?.name}`);
      
      success(res, {
        availability,
        updatedBy: req.user?.name
      }, 'Doctor availability updated successfully');
    } catch (err) {
      logger.error('Error updating doctor availability:', err);
      
      if (err.message === 'Doctor profile not found') {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      
      error(res, 'Failed to update doctor availability', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Deactivate doctor profile
  deactivateDoctor: async (req, res) => {
    try {
      const { id } = req.params;
      const { reason = 'Deactivated by admin' } = req.body;
      
      // Role-based access control
      if (req.user?.role !== 'ADMIN') {
        return error(res, 'Only administrators can deactivate doctor profiles', HTTP_STATUS.FORBIDDEN);
      }
      
      const result = await doctorService.deactivateDoctor(id, reason);
      
      logger.info(`Doctor profile deactivated for user ${id} by ${req.user?.name} - Reason: ${reason}`);
      
      success(res, {
        ...result,
        deactivatedBy: req.user?.name
      }, 'Doctor profile deactivated successfully');
    } catch (err) {
      logger.error('Error deactivating doctor:', err);
      
      if (err.message.includes('active appointments')) {
        return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
      }
      
      if (err.message === 'Doctor profile not found') {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      
      error(res, 'Failed to deactivate doctor profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Legacy controller methods for backward compatibility
  addDoctor: async (req, res) => {
    try {
      const { name, department, intro, imageUrl } = req.body;
      
      if (!name || !department) {
        return error(res, 'Doctor name and department are required', HTTP_STATUS.BAD_REQUEST);
      }
      
      const result = await prisma.$queryRawUnsafe(
        `INSERT INTO doctors (name, department, intro, image_url) VALUES ($1, $2, $3, $4) RETURNING id, name, department, intro, image_url, is_active, created_at`,
        name, department, intro, imageUrl
      );
      
      success(res, result[0], 'Doctor saved successfully');
    } catch (err) {
      logger.error('Error adding doctor:', err);
      error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
      
      success(res, deleteResult[0], 'Doctor deleted successfully');
    } catch (err) {
      logger.error('Error deleting doctor:', err);
      error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};
