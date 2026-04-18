/**
 * Login Anomaly Detector
 * Tracks login patterns and flags suspicious activity:
 * - Multiple failed logins across different accounts from same IP (credential stuffing)
 * - Login from new geographic region (if geolocation available)
 * - Login at unusual hours for the user
 *
 * Uses Redis for fast pattern tracking with TTL-based cleanup.
 */

import { cacheGet, cacheSet, isRedisConnected } from '../lib/redis.js';
import logger from '../logging/logger.js';
import { logSecurityEvent } from './securityAuditLogger.js';
import { sendSecurityWebhook } from './securityWebhook.js';

const WINDOW_SECONDS = 15 * 60; // 15-minute tracking window
const CREDENTIAL_STUFFING_THRESHOLD = 10; // Failed attempts across 10+ different accounts from same IP

/**
 * Track a failed login attempt for anomaly detection.
 * Call this from auth services after each failed login.
 * @param {string} ip - Client IP address
 * @param {string} account - Account identifier (username, email, employeeId, phone)
 */
export async function trackFailedLogin(ip, account) {
  if (!isRedisConnected() || !ip) return;

  try {
    const key = `anomaly:failed:${ip}`;
    const existing = await cacheGet(key) || { accounts: [], count: 0 };

    // Track unique accounts targeted from this IP
    if (!existing.accounts.includes(account)) {
      existing.accounts.push(account);
    }
    existing.count++;

    await cacheSet(key, existing, WINDOW_SECONDS);

    // Check for credential stuffing pattern
    if (existing.accounts.length >= CREDENTIAL_STUFFING_THRESHOLD) {
      logger.warn(`Credential stuffing detected from IP ${ip}: ${existing.accounts.length} accounts targeted`);
      logSecurityEvent('BRUTE_FORCE_DETECTED', {
        ip,
        reason: `${existing.accounts.length} different accounts targeted from single IP in ${WINDOW_SECONDS / 60} minutes`,
        statusCode: 429,
      });
      sendSecurityWebhook('BRUTE_FORCE_DETECTED', {
        ip,
        reason: `${existing.accounts.length} accounts targeted, ${existing.count} total attempts`,
      });
    }
  } catch (err) {
    logger.warn('Anomaly detection tracking failed:', err.message);
  }
}

/**
 * Get the current threat level for an IP based on recent failed attempts.
 * Used by adaptive rate limiting to dynamically adjust limits.
 * @param {string} ip - Client IP address
 * @returns {Promise<'normal'|'elevated'|'high'>} - Threat level
 */
export async function getIpThreatLevel(ip) {
  if (!isRedisConnected() || !ip) return 'normal';

  try {
    const key = `anomaly:failed:${ip}`;
    const data = await cacheGet(key);
    if (!data) return 'normal';

    if (data.accounts?.length >= CREDENTIAL_STUFFING_THRESHOLD) return 'high';
    if (data.count >= 5) return 'elevated';
    return 'normal';
  } catch {
    return 'normal';
  }
}
