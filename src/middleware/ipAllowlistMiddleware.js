// src/middleware/ipAllowlistMiddleware.js
// IP allowlisting middleware for admin panel access.
// When enabled (via ADMIN_IP_ALLOWLIST env var), restricts admin endpoints
// to a set of trusted IP addresses/CIDR ranges.

import logger from '../logging/logger.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';

/**
 * Parse the ADMIN_IP_ALLOWLIST environment variable.
 * Supports comma-separated IPs and CIDR notation.
 * Example: "192.168.1.0/24,10.0.0.1,2001:db8::/32"
 */
function parseAllowlist() {
  const raw = process.env.ADMIN_IP_ALLOWLIST || '';
  if (!raw.trim()) return null; // Disabled when not set

  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Check if an IP matches a CIDR range.
 * Supports both IPv4 and simple exact matching.
 */
function ipMatchesCIDR(ip, cidr) {
  // Exact match
  if (ip === cidr) return true;

  // Strip IPv6 prefix for IPv4-mapped addresses
  const normalizedIp = ip.replace(/^::ffff:/, '');
  if (normalizedIp === cidr) return true;

  // CIDR matching for IPv4
  if (cidr.includes('/')) {
    const [network, bits] = cidr.split('/');
    const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;
    const ipParts = normalizedIp.split('.').map(Number);
    const netParts = network.split('.').map(Number);

    if (ipParts.length !== 4 || netParts.length !== 4) return false;

    const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
    const netNum = (netParts[0] << 24) + (netParts[1] << 16) + (netParts[2] << 8) + netParts[3];

    return (ipNum & mask) === (netNum & mask);
  }

  return false;
}

/**
 * IP allowlist middleware for admin routes.
 * If ADMIN_IP_ALLOWLIST is not set, allows all traffic (disabled).
 * If set, blocks requests from IPs not in the allowlist.
 */
export function adminIpAllowlist(req, res, next) {
  const allowlist = parseAllowlist();

  // Feature disabled — allow all
  if (!allowlist) return next();

  const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress;

  if (!clientIp) {
    logger.warn('IP allowlist: Could not determine client IP');
    return res.status(403).json({
      success: false,
      message: 'Access denied: Unable to verify IP address',
    });
  }

  const isAllowed = allowlist.some(entry => ipMatchesCIDR(clientIp, entry));

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
      message: 'Access denied: Your IP address is not authorized for admin access',
    });
  }

  next();
}

export default adminIpAllowlist;
