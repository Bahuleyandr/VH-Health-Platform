import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as reminderService from '../../services/patient/medicationReminderService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

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

    // Accept the canonical snake_case forms plus the common clinical
    // abbreviations (OD/BD/TDS/QID/SOS/HS) that prescriptions actually
    // use. four_times_daily / QID matters for paediatric paracetamol
    // (and most antibiotic regimens) where the prescription writes Q6H
    // and the patient app needs four equally-spaced alerts. Aliases
    // normalise to the canonical token so the row stays consistent.
    // Finding: 2026-05-09-pediatric-opd-patient-reminder-no-qid.
    const FREQUENCY_ALIASES = {
      od: 'once_daily',
      qd: 'once_daily',
      bd: 'twice_daily',
      bid: 'twice_daily',
      tds: 'thrice_daily',
      tid: 'thrice_daily',
      qid: 'four_times_daily',
      qds: 'four_times_daily',
      q6h: 'four_times_daily',
      every_6_hours: 'four_times_daily',
      sos: 'as_needed',
      prn: 'as_needed',
      stat: 'stat',
      hs: 'at_bedtime',
    };
    const validFrequencies = new Set([
      'once_daily', 'twice_daily', 'thrice_daily', 'four_times_daily',
      'as_needed', 'stat', 'at_bedtime',
    ]);
    const normalised = String(frequency).trim().toLowerCase().replace(/\s+/g, '_');
    const canonicalFrequency = validFrequencies.has(normalised)
      ? normalised
      : (FREQUENCY_ALIASES[normalised] ?? null);
    if (!canonicalFrequency) {
      return error(
        res,
        `Invalid frequency. Must be one of: ${[...validFrequencies].join(', ')} (or aliases: OD/BD/TDS/QID/SOS/HS/STAT)`,
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    // For multi-dose frequencies, require reminder_times slot count
    // matches the cadence so the patient gets all the alerts the doctor
    // intended. four_times_daily with only 2 times is almost certainly
    // a typo and worth rejecting up-front.
    const expectedSlots = {
      once_daily: 1, twice_daily: 2, thrice_daily: 3, four_times_daily: 4,
    }[canonicalFrequency];
    if (expectedSlots && reminder_times.length !== expectedSlots) {
      return error(
        res,
        `Frequency ${canonicalFrequency} requires exactly ${expectedSlots} reminder_times`,
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    const reminder = await reminderService.createReminder(patientUid, {
      medication_name, dosage, frequency: canonicalFrequency, reminder_times, start_date, end_date, notes,
    });

    success(res, reminder, 'Medication reminder created', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Error creating medication reminder:', err);
    error(res, 'Failed to create medication reminder', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * GET /reminders/medication
 * Get medication reminders for the current patient. Active-only by
 * default; `?include_inactive=true` also returns deactivated reminders
 * so the app can show them dimmed and let the patient re-enable them.
 */
export const getActiveReminders = async (req, res) => {
  try {
    const patientUid = req.user.uid;
    const includeInactive = ['true', '1'].includes(
      String(req.query.include_inactive ?? '').toLowerCase(),
    );
    const reminders = await reminderService.getActiveReminders(patientUid, { includeInactive });

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
    // Relays AppErrors (404 not-found, 403 ANC read-only, 400 bad
    // is_active) with their real status + message; logs and returns a
    // generic 500 for everything else.
    return relayAppError(res, err, 'Failed to update medication reminder');
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
    // Relays AppErrors (404 not-found, 403 ANC read-only) with their
    // real status + message instead of collapsing the ANC 403 into a
    // generic 500 the app cannot explain to the patient.
    return relayAppError(res, err, 'Failed to deactivate medication reminder');
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
