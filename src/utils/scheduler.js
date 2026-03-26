// src/utils/scheduler.js

import cron from 'node-cron';
import path from 'path';
import backupDb from '../../admin/backup-db.js';
import { cleanupOldBackups as cleanupBackups } from '../../admin/cleanup-backups.js';
import purgeArchives from '../../admin/purge-archives.js';
import logger from '../logging/logger.js';
import purgeLogs from '../scripts/cleanup-logs.js';

// R2 Maintenance Jobs
import { scheduleArchiveMigrationJob } from './archiveMigrationJob.js';

// Notifications
import { sendAppointmentReminders } from './notifications/appointmentReminderJob.js';
import { sendInvestigationNotifications } from './notifications/InvestigationNotificationJob.js';
import { scheduleCleanupJob as scheduleR2CleanupJob, executeCleanup } from './r2CleanupJob.js';
import { purgeHousekeepingPhotos } from './housekeepingPurgeJob.js';
import loadSwaggerDocument from './swaggerLoader.js';
import { verifyLatestBackup } from './backupVerification.js';

// 🗓️ Daily at 00:00 - Purge old logs
cron.schedule('0 0 * * *', () => {
  logger.info('Scheduled Task: Purging old logs...');
  try {
    purgeLogs();
  } catch (err) {
    logger.error('Error during purgeLogs task:', err);
  }
});

// 🗓️ Daily at 00:00 - Swagger validation
cron.schedule('0 0 * * *', () => {
  logger.info('Scheduled Task: Validating Swagger...');
  try {
    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');
  } catch (err) {
    logger.error('Swagger validation failed:', err.message || err);
  }
});

// 🗓️ Daily at 02:00 - Backup database + verification
cron.schedule('0 2 * * *', () => {
  logger.info('Scheduled Task: Backing up database...');
  try {
    backupDb('.env', 'local');
    // After a small delay, verify the latest backup
    setTimeout(() => verifyLatestBackup(), 30000);
  } catch (err) {
    logger.error('Error during backupDb task:', err);
  }
});

// 🗓️ Monthly on 1st at 02:00 - Archive migration
scheduleArchiveMigrationJob();

// 🗓️ Daily at 03:00 - R2 Cleanup
scheduleR2CleanupJob();

// 🗓️ Weekly on Sunday at 03:00 - Purge archived logs
cron.schedule('0 3 * * 0', () => {
  logger.info('Scheduled Task: Purging .gz archived logs...');
  try {
    purgeArchives();
  } catch (err) {
    logger.error('Error during purgeArchives task:', err);
  }
});

// 🗓️ Weekly on Sunday at 04:00 - Cleanup old backups
cron.schedule('0 4 * * 0', () => {
  logger.info('Scheduled Task: Cleaning up old backups...');
  try {
    cleanupBackups(path.resolve('backups', 'local'));
    cleanupBackups(path.resolve('backups', 'render'));
  } catch (err) {
    logger.error('Error during cleanupBackups task:', err);
  }
});

// 🕗 Daily at 08:00 - Send appointment reminders
cron.schedule('0 8 * * *', async () => {
  logger.info('Scheduled Task: Sending appointment reminders...');
  try {
    await sendAppointmentReminders();
  } catch (err) {
    logger.error('Error sending appointment reminders:', err);
  }
});

// 🗓️ Daily at 09:00 - Send in-app investigation report notifications
cron.schedule('0 9 * * *', async () => {
  logger.info('Scheduled Task: Sending investigation report notifications...');
  try {
    await sendInvestigationNotifications();
  } catch (err) {
    logger.error('Error sending investigation notifications:', err);
  }
});

// 🗓️ Daily at 03:30 - Purge audit logs older than 90 days
cron.schedule('30 3 * * *', async () => {
  logger.info('Scheduled Task: Purging audit logs older than 90 days...');
  try {
    const { default: db } = await import('../config/database.js');
    const result = await db.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    logger.info(`✅ Audit log cleanup: ${result.rowCount} rows deleted`);
  } catch (err) {
    logger.error('Error during audit log cleanup:', err);
  }
});

// 🗓️ Daily at 03:45 - Purge housekeeping photos past retention window
cron.schedule('45 3 * * *', async () => {
  try {
    await purgeHousekeepingPhotos();
  } catch (err) {
    logger.error('Error during housekeeping photo purge:', err);
  }
});

// ✅ Manual Trigger for all tasks
export async function runAllScheduledTasksNow() {
  logger.info('Running all scheduled tasks manually...');
  try {
    purgeLogs();
    purgeArchives();

    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');

    backupDb('.env', 'local');
    await executeCleanup();

    cleanupBackups(path.resolve('backups', 'local'));
    cleanupBackups(path.resolve('backups', 'render'));

    await sendAppointmentReminders();
    await sendInvestigationNotifications();

    logger.info('✅ All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}

// ─── Payroll Crons ───────────────────────────────────────────────────────────

// 🗓️ Monthly on 1st at 06:00 — Auto-generate payroll for previous month
cron.schedule('0 6 1 * *', async () => {
  logger.info('Scheduled Task: Monthly payroll generation...');
  try {
    const now = new Date();
    let month = now.getMonth(); // 0-based = last month
    let year = now.getFullYear();
    if (month === 0) { month = 12; year--; }

    const { default: db } = await import('../config/database.js');
    const { calculatePayslip, savePayslip } = await import('../services/staff/payrollService.js');

    // Check if already done
    const existing = await db.query(
      'SELECT id, status FROM payroll_runs WHERE month=$1 AND year=$2',
      [month, year]
    );
    if (existing.rows.length > 0 && existing.rows[0].status === 'completed') {
      logger.info(`Payroll for ${month}/${year} already completed`);
      return;
    }

    // Get all active staff with salary config
    const staffList = await db.query(`
      SELECT ss.staff_uid, u.name, u.role,
             COALESCE(s.department, ss.department) as department
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      WHERE ss.is_active = true
    `);

    // Create / reset run
    const run = await db.query(
      `INSERT INTO payroll_runs (month, year, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (month, year) DO UPDATE SET status='processing'
       RETURNING *`,
      [month, year]
    );
    const runId = run.rows[0].id;

    let processed = 0;
    let totalGross = 0, totalNet = 0, totalDeductions = 0;
    for (const staff of staffList.rows) {
      try {
        const calc = await calculatePayslip(staff.staff_uid, month, year);
        await savePayslip(runId, calc);
        totalGross += parseFloat(calc.gross_salary) || 0;
        totalNet += parseFloat(calc.net_salary) || 0;
        totalDeductions += parseFloat(calc.total_deductions) || 0;
        processed++;
      } catch (e) {
        logger.warn(`Payroll calc failed for ${staff.staff_uid}: ${e.message}`);
      }
    }

    await db.query(
      `UPDATE payroll_runs SET status='completed', total_staff=$1, total_gross=$2, total_net=$3, total_deductions=$4 WHERE id=$5`,
      [processed, totalGross.toFixed(2), totalNet.toFixed(2), totalDeductions.toFixed(2), runId]
    );
    logger.info(`✅ Monthly payroll generated: ${processed} payslips for ${month}/${year}`);
  } catch (err) {
    logger.error('Monthly payroll cron failed:', err);
  }
});

// 🗓️ Annual on Dec 1 at 08:00 — Annual salary review reminder
cron.schedule('0 8 1 12 *', async () => {
  logger.info('Scheduled Task: Annual salary review reminder...');
  try {
    const year = new Date().getFullYear();
    const { default: db } = await import('../config/database.js');
    await db.query(`
      INSERT INTO annual_review_reminders (staff_uid, review_year, reminder_sent_at)
      SELECT ss.staff_uid, $1, NOW()
      FROM staff_salary ss
      WHERE ss.is_active = true
        AND ss.date_of_joining IS NOT NULL
        AND ss.date_of_joining::date <= CURRENT_DATE - INTERVAL '11 months'
      ON CONFLICT (staff_uid, review_year) DO NOTHING
    `, [year]);
    logger.info(`✅ Annual review reminders created for ${year}`);
  } catch (err) {
    logger.error('Annual review reminder cron failed:', err);
  }
});
