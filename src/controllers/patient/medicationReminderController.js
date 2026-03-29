import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as reminderService from '../../services/patient/medicationReminderService.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * POST /reminders/medication
 * Create a new medication reminder.
 */
export const createReminder = async (req, res) => {
  try {
    const patientUid = req.user.uid;
    const { medication_name, dosage, frequency, reminder_times, start_date, end_date, notes } = req.body;

    if (!medication_name || !dosage || !frequency || !reminder_times || !start_date) {
      return error(res, 'Missing required fields: medication_name, dosage, frequency, reminder_times, start_date', HTTP_STATUS.BAD_REQUEST);
    }

    if (!Array.isArray(reminder_times) || reminder_times.length === 0) {
      return error(res, 'reminder_times must be a non-empty array of time strings (HH:MM)', HTTP_STATUS.BAD_REQUEST);
    }

    const validFrequencies = ['once_daily', 'twice_daily', 'thrice_daily', 'as_needed'];
    if (!validFrequencies.includes(frequency)) {
      return error(res, `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }

    const reminder = await reminderService.createReminder(patientUid, {
      medication_name, dosage, frequency, reminder_times, start_date, end_date, notes,
    });

    success(res, reminder, 'Medication reminder created', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Error creating medication reminder:', err);
    error(res, 'Failed to create medication reminder', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * GET /reminders/medication
 * Get all active medication reminders for the current patient.
 */
export const getActiveReminders = async (req, res) => {
  try {
    const patientUid = req.user.uid;
    const reminders = await reminderService.getActiveReminders(patientUid);

    success(res, reminders, 'Active medication reminders retrieved');
  } catch (err) {
    logger.error('Error fetching medication reminders:', err);
    error(res, 'Failed to retrieve medication reminders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * PUT /reminders/medication/:id
 * Update an existing medication reminder.
 */
export const updateReminder = async (req, res) => {
  try {
    const patientUid = req.user.uid;
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return error(res, 'Invalid reminder ID', HTTP_STATUS.BAD_REQUEST);
    }

    const reminder = await reminderService.updateReminder(id, patientUid, req.body);
    success(res, reminder, 'Medication reminder updated');
  } catch (err) {
    if (err.statusCode === 404) {
      return error(res, 'Medication reminder not found', HTTP_STATUS.NOT_FOUND);
    }
    logger.error('Error updating medication reminder:', err);
    error(res, 'Failed to update medication reminder', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * DELETE /reminders/medication/:id
 * Soft-deactivate a medication reminder.
 */
export const deactivateReminder = async (req, res) => {
  try {
    const patientUid = req.user.uid;
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return error(res, 'Invalid reminder ID', HTTP_STATUS.BAD_REQUEST);
    }

    const reminder = await reminderService.deactivateReminder(id, patientUid);
    success(res, reminder, 'Medication reminder deactivated');
  } catch (err) {
    if (err.statusCode === 404) {
      return error(res, 'Medication reminder not found', HTTP_STATUS.NOT_FOUND);
    }
    logger.error('Error deactivating medication reminder:', err);
    error(res, 'Failed to deactivate medication reminder', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * GET /reminders/medication/due
 * Get reminders due in the next hour.
 */
export const getDueReminders = async (req, res) => {
  try {
    const patientUid = req.user.uid;
    const reminders = await reminderService.getDueReminders(patientUid);

    success(res, reminders, 'Due medication reminders retrieved');
  } catch (err) {
    logger.error('Error fetching due medication reminders:', err);
    error(res, 'Failed to retrieve due medication reminders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
