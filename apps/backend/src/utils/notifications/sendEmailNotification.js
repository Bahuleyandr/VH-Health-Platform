// src/utils/notifications/sendEmailNotification.js

import nodemailer from 'nodemailer';
import logger from '../../logging/logger.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
}

/**
 * Send an email notification.
 * Gracefully returns if SMTP is not configured.
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} [options.html] - HTML body
 * @param {string} [options.text] - Plain text body
 * @param {Array<Object>} [options.attachments] - nodemailer-style attachments
 */
export async function sendEmail({ to, subject, html, text, attachments, receiptMode = false }) {
  const transport = getTransporter();

  if (!transport) {
    logger.warn('📧 SMTP not configured — skipping email notification');
    return receiptMode
      ? { outcome: 'rejected', code: 'smtp_not_configured', messageId: null }
      : null;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  try {
    const info = await transport.sendMail({ from, to, subject, html, text, attachments });
    logger.info(`📧 Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`📧 Failed to send email to ${to}: ${err.message}`);
    if (receiptMode) {
      const failure = new Error('SMTP delivery outcome is uncertain', { cause: err });
      failure.code = err.code || 'SMTP_TRANSPORT_FAILURE';
      throw failure;
    }
    return null;
  }
}
