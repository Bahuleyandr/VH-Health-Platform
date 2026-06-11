// src/services/smsService.js
// SMS / WhatsApp notification service
// No external SMS provider is configured. Calls are logged as dry-run events.

import logger from '../logging/logger.js';

import { maskPhoneForLog } from '../utils/logMasking.js';
/**
 * Normalize a phone number to intl format (91XXXXXXXXXX)
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '').replace(/^0+/, '').replace(/^91/, '');
  if (digits.length < 10) return null;
  return `91${digits.slice(-10)}`;
}

/**
 * Send a raw SMS
 * @param {string} phone - Any format Indian mobile number
 * @param {string} message - Plain text message
 */
export async function sendSMS(phone, message) {
  const intlPhone = normalizePhone(phone);
  if (!intlPhone) {
    logger.warn('[SMS] Invalid/missing phone, skipping');
    return;
  }

  logger.info(`[SMS DRY RUN] To: ${maskPhoneForLog(intlPhone)} | ${message}`);
}

/**
 * Send appointment confirmation SMS to patient
 */
export async function sendAppointmentConfirmationSMS(phone, patientName, doctorName, date, time, tokenNumber, department) {
  if (!phone) return;
  try {
    const formattedDate = new Date(date).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    const deptPart = department ? ` (${department})` : '';
    const hospitalPhone = process.env.HOSPITAL_PHONE || '044-XXXXXXXX';
    const message =
      `Dear ${patientName}, your appointment at Venkataeswara Hospitals is confirmed.\n` +
      `Date: ${formattedDate}\nTime: ${time}\nDoctor: Dr. ${doctorName}${deptPart}\n` +
      `Token: #${tokenNumber}\n\nPlease arrive 15 min early. For queries call: ${hospitalPhone}`;
    await sendSMS(phone, message);
  } catch (err) {
    logger.warn('[SMS] Confirmation SMS error:', err.message);
  }
}

/**
 * Send appointment reminder SMS to patient
 */
export async function sendAppointmentReminderSMS(phone, patientName, doctorName, time, hoursAhead, tokenNumber) {
  if (!phone) return;
  try {
    const hoursLabel = hoursAhead > 1 ? `${hoursAhead} hours` : '1 hour';
    const message =
      `Reminder: Dear ${patientName}, you have an appointment at Venkataeswara Hospitals in ${hoursLabel}.\n` +
      `Time: ${time} | Dr. ${doctorName} | Token #${tokenNumber}`;
    await sendSMS(phone, message);
  } catch (err) {
    logger.warn('[SMS] Reminder SMS error:', err.message);
  }
}
