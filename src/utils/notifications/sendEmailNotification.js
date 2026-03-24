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
 */
export async function sendEmail({ to, subject, html, text }) {
  const transport = getTransporter();

  if (!transport) {
    logger.warn('📧 SMTP not configured — skipping email notification');
    return null;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  try {
    const info = await transport.sendMail({ from, to, subject, html, text });
    logger.info(`📧 Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`📧 Failed to send email to ${to}: ${err.message}`);
    return null;
  }
}
