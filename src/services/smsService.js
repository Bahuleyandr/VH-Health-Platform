// src/services/smsService.js
// SMS / WhatsApp notification service
// Provider: MSG91 (if MSG91_API_KEY is set) — falls back to dry-run logging

import logger from '../logging/logger.js';

// Supported: 'msg91' | 'none'
// MSG91_API_KEY is the credential key name in .env
const SMS_PROVIDER = process.env.SMS_PROVIDER || (process.env.MSG91_API_KEY ? 'msg91' : 'none');

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

  try {
    if (SMS_PROVIDER === 'msg91' && process.env.MSG91_API_KEY) {
      // MSG91 simple transactional SMS via v5 API
      const body = JSON.stringify({
        sender: process.env.MSG91_SENDER_ID || 'VHHLTH',
        route: '4', // transactional
        country: '91',
        sms: [{ message, to: [intlPhone] }]
      });

      const resp = await fetch('https://api.msg91.com/api/v5/sendotp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authkey': process.env.MSG91_API_KEY
        },
        body
      });

      // MSG91 v5 transactional text SMS endpoint
      const textResp = await fetch(`https://api.msg91.com/api/sendhttp.php?authkey=${process.env.MSG91_API_KEY}&mobiles=${intlPhone}&message=${encodeURIComponent(message)}&sender=${process.env.MSG91_SENDER_ID || 'VHHLTH'}&route=4&country=91`, {
        method: 'GET'
      });
      const result = await textResp.text();
      logger.info(`[SMS] MSG91 response for ${intlPhone}: ${result}`);
    } else {
      // Dry run — no credentials configured
      logger.info(`[SMS DRY RUN] To: ${intlPhone} | ${message}`);
    }
  } catch (err) {
    logger.warn(`[SMS] Send failed for ${phone}: ${err.message}`);
    // Never throw — fire-and-forget
  }
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
