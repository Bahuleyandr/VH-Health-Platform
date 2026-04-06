// src/utils/scheduler.js

import cron from 'node-cron';
import path from 'path';
import backupDb from '../../admin/backup-db.js';
import { cleanupOldBackups as cleanupBackups } from '../../admin/cleanup-backups.js';
import purgeArchives from '../../admin/purge-archives.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

const runningJobs = new Set();

function withJobLock(jobName, fn) {
  return async () => {
    if (runningJobs.has(jobName)) {
      logger.warn(`Skipping ${jobName} — previous run still active`);
      return;
    }
    runningJobs.add(jobName);
    const start = Date.now();
    try {
      await fn();
      logger.info(`Job ${jobName} completed in ${Date.now() - start}ms`);
    } catch (err) {
      logger.error(`Job ${jobName} failed after ${Date.now() - start}ms:`, err);
    } finally {
      runningJobs.delete(jobName);
    }
  };
}
import purgeLogs from '../scripts/cleanup-logs.js';

// R2 Maintenance Jobs
import { retryFailedNotifications } from '../services/notificationRetryService.js';
import { scheduleArchiveMigrationJob } from './archiveMigrationJob.js';

// Notifications
import { verifyLatestBackup } from './backupVerification.js';
import { runCanaryChecks } from './canaryHealthCheck.js';
import { purgeHousekeepingPhotos } from './housekeepingPurgeJob.js';
import { sendAppointmentReminders, sendTimedReminders, processPendingScheduledNotifications } from './notifications/appointmentReminderJob.js';
import { sendInvestigationNotifications } from './notifications/InvestigationNotificationJob.js';
import { escalateStuckOrders } from './notifications/stuckOrderEscalation.js';
import { scheduleCleanupJob as scheduleR2CleanupJob, executeCleanup } from './r2CleanupJob.js';
import { detectSchemaDrift } from './schemaDriftDetector.js';
import loadSwaggerDocument from './swaggerLoader.js';

// 🗓️ Daily at 00:00 - Purge old logs
cron.schedule('0 0 * * *', withJobLock('purge-logs', async () => {
  logger.info('Scheduled Task: Purging old logs...');
  await purgeLogs();
}));

// 🗓️ Daily at 00:00 - Swagger validation
cron.schedule('0 0 * * *', withJobLock('swagger-validation', async () => {
  logger.info('Scheduled Task: Validating Swagger...');
  const swaggerDocument = loadSwaggerDocument();
  if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
  logger.info('✅ Swagger documentation validated.');
}));

// 🗓️ Daily at 02:00 - Backup database + verification
cron.schedule('0 2 * * *', withJobLock('backup-db', async () => {
  logger.info('Scheduled Task: Backing up database...');
  await backupDb('.env', 'local');
  // After a small delay, verify the latest backup
  await new Promise(resolve => setTimeout(resolve, 30000));
  await verifyLatestBackup();
}));

// 🗓️ Monthly on 1st at 02:00 - Archive migration
scheduleArchiveMigrationJob();

// 🗓️ Daily at 03:00 - R2 Cleanup
scheduleR2CleanupJob();

// 🗓️ Weekly on Sunday at 03:00 - Purge archived logs
cron.schedule('0 3 * * 0', withJobLock('purge-archives', async () => {
  logger.info('Scheduled Task: Purging .gz archived logs...');
  await purgeArchives();
}));

// 🗓️ Weekly on Sunday at 04:00 - Cleanup old backups
cron.schedule('0 4 * * 0', withJobLock('cleanup-backups', async () => {
  logger.info('Scheduled Task: Cleaning up old backups...');
  await cleanupBackups(path.resolve('backups', 'local'));
  await cleanupBackups(path.resolve('backups', 'render'));
}));

// 🕗 Daily at 08:00 - Send appointment reminders (existing daily push-only)
cron.schedule('0 8 * * *', withJobLock('send-appointment-reminders', sendAppointmentReminders));

// ⏰ Every hour - Send 24h and 1h SMS+push appointment reminders
cron.schedule('0 * * * *', withJobLock('timed-reminders', sendTimedReminders));

// 🔔 Every 5 minutes - Process pending scheduled notifications (feedback requests, etc.)
cron.schedule('*/5 * * * *', withJobLock('process-scheduled-notifications', processPendingScheduledNotifications));

// 🔄 Every 5 minutes - Retry failed push/SMS notifications (exponential backoff)
cron.schedule('*/5 * * * *', withJobLock('retry-failed-notifications', retryFailedNotifications));

// ⚠️ Every 30 minutes - Escalate stuck orders (appointments, pharmacy, investigations)
cron.schedule('*/30 * * * *', withJobLock('escalate-stuck-orders', escalateStuckOrders));

// 🗓️ Daily at 09:00 - Send in-app investigation report notifications
cron.schedule('0 9 * * *', withJobLock('investigation-notifications', sendInvestigationNotifications));

// 🗓️ Daily at 03:30 - Purge audit logs older than 90 days
cron.schedule('30 3 * * *', withJobLock('purge-audit-logs', async () => {
  logger.info('Scheduled Task: Purging audit logs older than 90 days...');
  const result = await prisma.$queryRawUnsafe(
    `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`
  );
  logger.info(`Audit log cleanup: ${result.length} rows deleted`);
}));

// 🗓️ Daily at 03:35 - Purge expired token blacklist entries
cron.schedule('35 3 * * *', withJobLock('purge-invalidated-tokens', async () => {
  logger.info('Scheduled Task: Purging expired invalidated tokens...');
  const result = await prisma.$queryRawUnsafe(
    `DELETE FROM invalidated_tokens WHERE expires_at < NOW()`
  );
  logger.info(`Invalidated tokens cleanup: ${result.length} rows deleted`);
}));

// 🗓️ Daily at 03:40 - Purge expired OTP sessions
cron.schedule('40 3 * * *', withJobLock('purge-expired-otps', async () => {
  logger.info('Scheduled Task: Purging expired OTP sessions...');
  const result = await prisma.$queryRawUnsafe(
    `DELETE FROM otp_sessions WHERE expires_at < NOW() - INTERVAL '1 day'`
  );
  logger.info(`Expired OTP cleanup: ${result.length} rows deleted`);
}));

// 🗓️ Daily at 03:45 - Purge housekeeping photos past retention window
cron.schedule('45 3 * * *', withJobLock('purge-housekeeping-photos', purgeHousekeepingPhotos));

// Every 5 minutes - Canary health check (synthetic tests against critical paths)
cron.schedule('*/5 * * * *', withJobLock('canary-health-check', async () => {
  await runCanaryChecks();
}));

// Schema drift detection — once at startup
setImmediate(async () => {
  try { await detectSchemaDrift(); } catch (e) { logger.warn('Schema drift check failed:', e.message); }
});

// ✅ Manual Trigger for all tasks
export async function runAllScheduledTasksNow() {
  logger.info('Running all scheduled tasks manually...');
  try {
    await purgeLogs();
    await purgeArchives();

    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');

    await backupDb('.env', 'local');
    await executeCleanup();

    await cleanupBackups(path.resolve('backups', 'local'));
    await cleanupBackups(path.resolve('backups', 'render'));

    await sendAppointmentReminders();
    await sendTimedReminders();
    await processPendingScheduledNotifications();
    await sendInvestigationNotifications();

    logger.info('✅ All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}

// ─── Payroll Crons ───────────────────────────────────────────────────────────

// 🗓️ Monthly on 1st at 06:00 — Auto-generate payroll for previous month
cron.schedule('0 6 1 * *', withJobLock('monthly-payroll', async () => {
  logger.info('Scheduled Task: Monthly payroll generation...');
  const now = new Date();
  let month = now.getMonth(); // 0-based = last month
  let year = now.getFullYear();
  if (month === 0) { month = 12; year--; }

  const { calculatePayslip, savePayslip } = await import('../services/staff/payrollService.js');

  // Check if already done
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM payroll_runs WHERE month=$1 AND year=$2',
    [month, year]
  );
  if (existing.length > 0 && existing[0].status === 'completed') {
    logger.info(`Payroll for ${month}/${year} already completed`);
    return;
  }

  // Get all active staff with salary config
  const staffList = await prisma.$queryRawUnsafe(`
    SELECT ss.staff_uid, u.name, u.role,
           COALESCE(s.department, ss.department) as department
    FROM staff_salary ss
    JOIN users u ON ss.staff_uid = u.uid
    LEFT JOIN staff s ON s.user_id = u.id
    WHERE ss.is_active = true
  `);

  // Create / reset run
  const run = await prisma.$queryRawUnsafe(
    `INSERT INTO payroll_runs (month, year, status)
     VALUES ($1, $2, 'processing')
     ON CONFLICT (month, year) DO UPDATE SET status='processing'
     RETURNING id, month, year, status, total_staff, total_gross, total_net, total_deductions, created_at`,
    [month, year]
  );
  const runId = run[0].id;

  let processed = 0;
  let totalGross = 0, totalNet = 0, totalDeductions = 0;
  for (const staff of staffList) {
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

  await prisma.$queryRawUnsafe(
    `UPDATE payroll_runs SET status='completed', total_staff=$1, total_gross=$2, total_net=$3, total_deductions=$4 WHERE id=$5`,
    [processed, totalGross.toFixed(2), totalNet.toFixed(2), totalDeductions.toFixed(2), runId]
  );
  logger.info(`Monthly payroll generated: ${processed} payslips for ${month}/${year}`);
}));

// 🗓️ Annual on Dec 1 at 08:00 — Annual salary review reminder
cron.schedule('0 8 1 12 *', withJobLock('annual-salary-review', async () => {
  logger.info('Scheduled Task: Annual salary review reminder...');
  const year = new Date().getFullYear();
  await prisma.$queryRawUnsafe(`
    INSERT INTO annual_review_reminders (staff_uid, review_year, reminder_sent_at)
    SELECT ss.staff_uid, $1, NOW()
    FROM staff_salary ss
    WHERE ss.is_active = true
      AND ss.date_of_joining IS NOT NULL
      AND ss.date_of_joining::date <= CURRENT_DATE - INTERVAL '11 months'
    ON CONFLICT (staff_uid, review_year) DO NOTHING
  `, [year]);
  logger.info(`Annual review reminders created for ${year}`);
}));
