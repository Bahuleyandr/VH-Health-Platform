// src/middleware/ipAllowlistMiddleware.js
// IP allowlisting middleware for admin panel access.
// Production fails closed: ADMIN_IP_ALLOWLIST must name trusted client
// addresses/CIDR ranges before admin endpoints are reachable.

import logger from '../logging/logger.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';

/**
 * Parse the ADMIN_IP_ALLOWLIST environment variable.
 * Supports comma-separated IPs and CIDR notation.
 * Example: "192.168.1.0/24,10.0.0.1,2001:db8::/32"
 */
export function isProductionRuntime(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

export function parseAdminIpAllowlist(raw = process.env.ADMIN_IP_ALLOWLIST || '') {
  if (!String(raw).trim()) return [];

  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Parse an IPv4 address into an unsigned 32-bit integer.
 */
function ipv4ToNumber(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) + octet) >>> 0;
  }

  return value >>> 0;
}

/**
 * Check if an IP matches an exact address or IPv4 CIDR range.
 */
export function ipMatchesCIDR(ip, cidr) {
  if (!ip || !cidr) return false;

  // Exact match
  if (ip === cidr) return true;

  // Strip IPv6 prefix for IPv4-mapped addresses
  const normalizedIp = ip.replace(/^::ffff:/, '');
  if (normalizedIp === cidr) return true;

  // CIDR matching for IPv4
  if (cidr.includes('/')) {
    const [network, bitsRaw] = cidr.split('/');
    if (!network || !/^\d{1,2}$/.test(bitsRaw || '')) return false;

    const bits = Number(bitsRaw);
    if (bits < 0 || bits > 32) return false;

    const ipNum = ipv4ToNumber(normalizedIp);
    const netNum = ipv4ToNumber(network);
    if (ipNum == null || netNum == null) return false;

    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

    return (ipNum & mask) === (netNum & mask);
  }

  return false;
}

export function isIpAllowedByAdminAllowlist(ip, allowlist) {
  return allowlist.some(entry => ipMatchesCIDR(ip, entry));
}

/**
 * IP allowlist middleware for admin routes.
 * If ADMIN_IP_ALLOWLIST is not set, development allows traffic and production
 * rejects traffic until operators configure the allowlist.
 */
export function adminIpAllowlist(req, res, next) {
  const allowlist = parseAdminIpAllowlist();

  // Development keeps the old no-allowlist behavior. Production fails closed.
  if (allowlist.length === 0) {
    if (!isProductionRuntime()) return next();

    logger.error('IP allowlist: ADMIN_IP_ALLOWLIST is required in production');
    logSecurityEvent('ADMIN_IP_ALLOWLIST_MISSING', {
      userId: req.user?.uid || 'unknown',
      userRole: req.user?.role || 'unknown',
      path: req.originalUrl,
    });
    return res.status(403).json({
      success: false,
      code: 'ADMIN_IP_ALLOWLIST_REQUIRED',
      message: 'Access denied: Admin IP allowlist is not configured',
    });
  }

  // Use req.ip which respects Express 'trust proxy' setting (app.set('trust proxy', 1)).
  // Do NOT read x-forwarded-for directly — clients can spoof it without trust proxy.
  const clientIp = req.ip;

  if (!clientIp) {
    logger.warn('IP allowlist: Could not determine client IP');
    return res.status(403).json({
      success: false,
      message: 'Access denied: Unable to verify IP address',
    });
  }

  const isAllowed = isIpAllowedByAdminAllowlist(clientIp, allowlist);

  if (!isAllowed) {
    logger.warn(`IP allowlist: Blocked admin access from ${clientIp}`);
    logSecurityEvent('ADMIN_IP_BLOCKED', {
      ip: clientIp,
      userId: req.user?.uid || 'unknown',
      userRole: req.user?.role || 'unknown',
      path: req.originalUrl,
    });
    return res.status(403).json({
      success: false,
      code: 'ADMIN_IP_NOT_ALLOWED',
      message: 'Access denied: Your IP address is not authorized for admin access',
    });
  }

  next();
}

export default adminIpAllowlist;
