/**
 * Housekeeping Photo Purge Job
 *
 * Runs daily. Deletes R2 objects for housekeeping logs/requests older than 90 days,
 * then clears the photo_key/photo_url columns in DB (keeps the record, removes the file).
 *
 * Strategy:
 * - Verified logs older than 90 days: purge photo
 * - Unverified logs older than 180 days: purge photo (grace period for dispute)
 * - Completed/verified requests older than 90 days: purge completion photo
 * - Open/assigned requests older than 30 days with no completion: purge request photo (stale)
 */

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { deleteObject } from './r2Storage.js';

const RETENTION = {
  verified_log_days: 90,
  unverified_log_days: 180,
  completed_request_days: 90,
  stale_open_request_days: 30,
};

export async function purgeHousekeepingPhotos() {
  // Lazy import to avoid circular deps / startup issues
  const { default: db } = await import('../config/database.js');

  logger.info('🧹 Starting housekeeping photo purge...');
  let purged = 0;
  let errors = 0;

  try {
    // ── 1. Verified cleaning logs older than 90 days ──────────────────────────
    const expiredVerified = await prisma.$queryRawUnsafe(`
      SELECT id, photo_key FROM housekeeping_logs
      WHERE photo_key IS NOT NULL
        AND status = 'verified'
        AND logged_at < NOW() - $1::INTERVAL
    `, [`${RETENTION.verified_log_days} days`]);

    for (const row of expiredVerified) {
      try {
        await deleteObject(row.photo_key);
        await prisma.$queryRawUnsafe(
          `UPDATE housekeeping_logs SET photo_key = NULL, photo_url = NULL WHERE id = $1`,
          [row.id]
        );
        purged++;
      } catch (e) {
        logger.warn(`Failed to purge HK log photo ${row.photo_key}: ${e.message}`);
        errors++;
      }
    }

    // ── 2. Unverified logs older than 180 days (grace period) ─────────────────
    const expiredUnverified = await prisma.$queryRawUnsafe(`
      SELECT id, photo_key FROM housekeeping_logs
      WHERE photo_key IS NOT NULL
        AND status != 'verified'
        AND logged_at < NOW() - $1::INTERVAL
    `, [`${RETENTION.unverified_log_days} days`]);

    for (const row of expiredUnverified) {
      try {
        await deleteObject(row.photo_key);
        await prisma.$queryRawUnsafe(
          `UPDATE housekeeping_logs SET photo_key = NULL, photo_url = NULL WHERE id = $1`,
          [row.id]
        );
        purged++;
      } catch (e) {
        logger.warn(`Failed to purge unverified HK log photo ${row.photo_key}: ${e.message}`);
        errors++;
      }
    }

    // ── 3. Completed/verified requests older than 90 days ────────────────────
    const expiredCompleted = await prisma.$queryRawUnsafe(`
      SELECT id, photo_key, completion_photo_key FROM housekeeping_requests
      WHERE status IN ('completed','verified','closed')
        AND created_at < NOW() - $1::INTERVAL
    `, [`${RETENTION.completed_request_days} days`]);

    for (const row of expiredCompleted) {
      const keysToDelete = [row.photo_key, row.completion_photo_key].filter(Boolean);
      for (const key of keysToDelete) {
        try {
          await deleteObject(key);
          purged++;
        } catch (e) {
          logger.warn(`Failed to purge HK request photo ${key}: ${e.message}`);
          errors++;
        }
      }
      if (keysToDelete.length) {
        await prisma.$queryRawUnsafe(`
          UPDATE housekeeping_requests SET
            photo_key = NULL, photo_url = NULL,
            completion_photo_key = NULL, completion_photo_url = NULL
          WHERE id = $1
        `, [row.id]);
      }
    }

    // ── 4. Stale open requests (30+ days, never actioned) ────────────────────
    const staleOpen = await prisma.$queryRawUnsafe(`
      SELECT id, photo_key FROM housekeeping_requests
      WHERE photo_key IS NOT NULL
        AND status IN ('open','assigned')
        AND created_at < NOW() - $1::INTERVAL
    `, [`${RETENTION.stale_open_request_days} days`]);

    for (const row of staleOpen) {
      try {
        await deleteObject(row.photo_key);
        await prisma.$queryRawUnsafe(
          `UPDATE housekeeping_requests SET photo_key = NULL, photo_url = NULL WHERE id = $1`,
          [row.id]
        );
        purged++;
      } catch (e) {
        logger.warn(`Failed to purge stale HK request photo ${row.photo_key}: ${e.message}`);
        errors++;
      }
    }

    logger.info(`✅ Housekeeping photo purge complete. Purged: ${purged}, Errors: ${errors}`);
    return { purged, errors };
  } catch (err) {
    logger.error('Housekeeping photo purge job failed:', err);
    return { purged, errors: errors + 1 };
  }
}
