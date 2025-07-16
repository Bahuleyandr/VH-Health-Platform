// src/controllers/doctor/adminDoctorController.js
import { validationResult } from 'express-validator';
import db from '../../config/database.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { adminDoctorService } from '../../services/doctor/adminDoctorService.js';
import { success, error } from '../../utils/responseHelper.js';

export const adminDoctorController = {
  // Test endpoint
  test: (req, res) => {
    res.json({ 
      message: 'Admin doctor routes working!',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      user: req.user?.role || 'anonymous'
    });
  },

  // Get doctor management overview
  getDoctorOverview: async (req, res) => {
    try {
      const overview = await adminDoctorService.getDoctorOverview();
      
      res.json({
        message: 'Doctor management overview retrieved successfully',
        overview,
        generated_at: new Date().toLocaleDateString('en-GB')
      });
    } catch (err) {
      logger.error('Error fetching doctor overview:', err);
      res.status(500).json({
        message: 'Failed to retrieve doctor overview',
        error: err.message
      });
    }
  },

  // Get doctor management list
  getDoctorManagementList: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation error',
          errors: errors.array()
        });
      }
      
      const filters = {
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 20,
        department: req.query.department,
        specialization: req.query.specialization,
        status: req.query.status,
        experience_min: req.query.experience_min,
        experience_max: req.query.experience_max,
        search: req.query.search
      };
      
      const result = await adminDoctorService.getDoctorManagementList(filters);
      
      res.json({
        message: 'Doctor management data retrieved successfully',
        doctors: result.doctors,
        pagination: result.pagination,
        filters: result.filters
      });
    } catch (err) {
      logger.error('Error fetching doctor management list:', err);
      res.status(500).json({
        message: 'Failed to retrieve doctor management data',
        error: err.message
      });
    }
  },

  // Create doctor account
  createDoctorAccount: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation error',
          errors: errors.array()
        });
      }
      
      const result = await adminDoctorService.createDoctorAccount(req.body);
      
      logger.info(`[adminDoctorRoutes] Doctor account created: ${req.body.name} (${req.body.phone}) by ${req.user?.uid}`);
      
      res.status(201).json({
        message: 'Doctor account created successfully',
        user: result.user,
        doctor_profile: result.doctor_profile
      });
    } catch (err) {
      logger.error('Error creating doctor account:', err);
      
      if (err.message.includes('already exists')) {
        return res.status(409).json({
          message: err.message
        });
      }
      
      res.status(500).json({
        message: 'Failed to create doctor account',
        error: err.message
      });
    }
  },

  // Bulk doctor operations
  performBulkOperations: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation error',
          errors: errors.array()
        });
      }
      
      const { operation, doctor_ids, data } = req.body;
      const result = await adminDoctorService.performBulkOperation(operation, doctor_ids, data);
      
      logger.info(`[adminDoctorRoutes] Bulk ${operation} performed on ${doctor_ids.length} doctors by ${req.user?.uid}`);
      
      res.json({
        message: `Bulk ${operation} operation completed successfully`,
        ...result
      });
    } catch (err) {
      logger.error('Error performing bulk operations:', err);
      res.status(500).json({
        message: 'Failed to perform bulk operation',
        error: err.message
      });
    }
  },

  // Update doctor profile (admin)
  updateDoctorProfile: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation error',
          errors: errors.array()
        });
      }
      
      const { id } = req.params;
      
      // Verify doctor exists
      const doctorCheck = await db.query(
        'SELECT u.name FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.id = $1 AND u.role = $2',
        [id, 'DOCTOR']
      );
      
      if (doctorCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Doctor not found' });
      }
      
      const result = await db.query(`
        UPDATE doctors SET 
          specialization = COALESCE($1, specialization),
          department = COALESCE($2, department),
          experience_years = COALESCE($3, experience_years),
          consultation_fee = COALESCE($4, consultation_fee),
          available_days = COALESCE($5, available_days),
          available_hours = COALESCE($6, available_hours),
          bio = COALESCE($7, bio),
          education = COALESCE($8, education),
          certifications = COALESCE($9, certifications),
          is_available = COALESCE($10, is_available),
          updated_at = NOW()
        WHERE user_id = $11
        RETURNING *
      `, [
        req.body.specialization,
        req.body.department,
        req.body.experience_years,
        req.body.consultation_fee,
        req.body.available_days,
        req.body.available_hours,
        req.body.bio,
        req.body.education,
        req.body.certifications,
        req.body.is_available,
        id
      ]);
      
      logger.info(`[adminDoctorRoutes] Doctor profile updated: ${id} by ${req.user?.uid}`);
      
      res.json({
        message: 'Doctor profile updated successfully',
        doctor: {
          ...result.rows[0],
          name: doctorCheck.rows[0].name
        }
      });
    } catch (err) {
      logger.error('Error updating doctor profile:', err);
      res.status(500).json({
        message: 'Failed to update doctor profile',
        error: err.message
      });
    }
  },

  // Update doctor availability
  updateDoctorAvailability: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation error',
          errors: errors.array()
        });
      }
      
      const { id } = req.params;
      
      if (typeof req.body.is_available !== 'boolean') {
        return res.status(400).json({
          message: 'is_available must be a boolean value'
        });
      }
      
      const result = await adminDoctorService.updateDoctorAvailability(id, req.body);
      
      logger.info(`[adminDoctorRoutes] Doctor ${id} availability updated by ${req.user?.uid}`);
      
      res.json({
        message: 'Doctor availability updated successfully',
        ...result
      });
    } catch (err) {
      logger.error('Error updating doctor availability:', err);
      
      if (err.message === 'Doctor not found') {
        return res.status(404).json({ message: err.message });
      }
      
      res.status(500).json({
        message: 'Failed to update doctor availability',
        error: err.message
      });
    }
  },

  // Delete doctor account
  deleteDoctorAccount: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation error',
          errors: errors.array()
        });
      }
      
      const { id } = req.params;
      const result = await adminDoctorService.deleteDoctorAccount(id, req.body);
      
      logger.info(`[adminDoctorRoutes] Doctor account deleted: ${result.doctor.name} by ${req.user?.uid} (${result.appointments_handled.future_appointments} appointments handled)`);
      
      res.json({
        message: 'Doctor account deleted successfully',
        ...result
      });
    } catch (err) {
      logger.error('Error deleting doctor account:', err);
      
      if (err.message === 'Doctor not found') {
        return res.status(404).json({ message: err.message });
      }
      
      if (err.message.includes('future appointments')) {
        return res.status(400).json({
          message: err.message,
          suggestion: 'Provide transfer_patients_to doctor ID or cancel appointments first'
        });
      }
      
      res.status(500).json({
        message: 'Failed to delete doctor account',
        error: err.message
      });
    }
  },

  // Legacy endpoints
  addDoctor: async (req, res) => {
    try {
      const { name, department, intro, imageUrl } = req.body;
      
      if (!name || !department) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: RESPONSE_MESSAGES.VALIDATION_FAILED,
          details: 'Doctor name and department are required.'
        });
      }
      
      const result = await db.query(
        `INSERT INTO doctors (name, department, intro, image_url) VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, department, intro, imageUrl]
      );
      
      success(res, result.rows[0], 'Doctor saved successfully');
    } catch (err) {
      logger.error(err.stack || err.toString());
      error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
    }
  },

  deleteDoctor: async (req, res) => {
    try {
      const { doctorId } = req.params;
      
      const deleteResult = await db.query(
        'DELETE FROM doctors WHERE id = $1 RETURNING *',
        [doctorId]
      );
      
      if (deleteResult.rowCount === 0) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          error: RESPONSE_MESSAGES.NOT_FOUND,
          details: 'Doctor not found or already deleted.'
        });
      }
      
      logger.info(`[adminDoctorRoutes] Doctor deleted: ${doctorId} by ${req.user?.uid}`);
      success(res, deleteResult.rows[0], 'Doctor deleted successfully');
    } catch (err) {
      logger.error(err.stack || err.toString());
      error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
    }
  }
};