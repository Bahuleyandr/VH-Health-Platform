// src/utils/ssrfGuard.js
//
// SSRF guard for server-side outbound HTTP to user/operator-supplied URLs
// (audit finding H4 2026-06-10: HL7 outbound feeds validated only the URL
// *scheme*, letting an insider point a feed at 127.0.0.1, RFC-1918 space, or
// the cloud metadata endpoint and have the backend POST to it — with an
// attacker-chosen Authorization header).
//
// Policy (fail closed):
//   - Only http/https URLs, no embedded credentials.
//   - The hostname must not be, or resolve to, a loopback / private /
//     link-local / CGNAT / multicast / reserved / ULA / unspecified address.
//     EVERY resolved address must be publicly routable.
//   - DNS resolution failure ⇒ reject (we can't tell ⇒ deny).
//   - Optional operator allowlist via HL7_FEED_HOST_ALLOWLIST (comma-separated
//     hostnames). When set, only those exact hostnames are accepted — the
//     strongest control; recommended for production.
//   - Callers MUST re-run the check immediately before every fetch (not just
//     at create time) so a DNS-rebinding host that flips to an internal IP
//     after subscription-create is still caught at delivery time.

import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from './AppError.js';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const BLOCKED_V4_CIDRS = [
  ['0.0.0.0', 8],          // "this network" / unspecified
  ['10.0.0.0', 8],         // RFC 1918
  ['100.64.0.0', 10],      // CGNAT (RFC 6598)
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local + cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],      // RFC 1918
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.168.0.0', 16],     // RFC 1918
  ['198.18.0.0', 15],      // benchmarking
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved + broadcast
].map(([base, bits]) => ({ base: ipv4ToInt(base), bits }));

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value == null) return true; // unparsable ⇒ deny
  return BLOCKED_V4_CIDRS.some(({ base, bits }) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();
  // v4-mapped / v4-translated (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) — check the
  // embedded IPv4.
  const v4Match = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) return isBlockedIpv4(v4Match[1]);
  if (lower === '::' || lower === '::1') return true;        // unspecified / loopback
  if (/^fe[89ab]/.test(lower)) return true;                  // link-local fe80::/10
  if (/^f[cd]/.test(lower)) return true;                     // ULA fc00::/7
  if (/^ff/.test(lower)) return true;                        // multicast ff00::/8
  if (lower.startsWith('2001:db8')) return true;             // documentation
  return false;
}

/**
 * True when `address` (an IP literal) must not be contacted from the server.
 * Unparsable input is treated as blocked (fail closed).
 */
export function isBlockedAddress(address) {
  const family = net.isIP(String(address || ''));
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function getHostAllowlist(envName = 'HL7_FEED_HOST_ALLOWLIST') {
  return (process.env[envName] || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * TEST-ONLY escape hatch: lets integration tests deliver to a local listener
 * (e.g. hl7-outbound.deep.test.js spins an http.Server on 127.0.0.1).
 * HARD-REFUSED in production regardless of the env var — the address checks
 * can never be disabled where PHI is live.
 */
function privateTargetsAllowedForTests(envName = 'HL7_FEED_ALLOW_PRIVATE_TARGETS') {
  return (
    process.env[envName] === 'true'
    && (process.env.NODE_ENV || '').toLowerCase() !== 'production'
  );
}

/**
 * Validates an outbound feed URL. Throws AppError (400-class, code
 * SSRF_BLOCKED) when the URL is unsafe; resolves with the parsed URL
 * otherwise. MUST be called both at subscription-create AND immediately
 * before every delivery fetch (DNS-rebinding defence).
 */
export async function assertSafeOutboundUrl(rawUrl, {
  label = 'endpoint_url',
  allowlistEnv = 'HL7_FEED_HOST_ALLOWLIST',
  allowPrivateEnv = 'HL7_FEED_ALLOW_PRIVATE_TARGETS',
} = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw AppError.badRequest(`${label} is not a valid URL`, 'SSRF_BLOCKED');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw AppError.badRequest(`${label} must be an http(s) URL`, 'SSRF_BLOCKED');
  }
  if (url.username || url.password) {
    throw AppError.badRequest(`${label} must not embed credentials`, 'SSRF_BLOCKED');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  const allowlist = getHostAllowlist(allowlistEnv);
  if (allowlist.length > 0 && !allowlist.includes(hostname.toLowerCase())) {
    throw AppError.badRequest(
      `${label} host is not on the approved host allowlist (${allowlistEnv})`,
      'SSRF_BLOCKED',
    );
  }

  if (privateTargetsAllowedForTests(allowPrivateEnv)) {
    return url; // test-only; impossible in production (see above)
  }

  // IP-literal host: check directly, no DNS involved.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw AppError.badRequest(
        `${label} targets a private/loopback/link-local address`,
        'SSRF_BLOCKED',
      );
    }
    return url;
  }

  // DNS name: resolve and require EVERY address to be publicly routable.
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // Can't resolve ⇒ can't prove it's safe ⇒ deny (fail closed).
    throw AppError.badRequest(
      `${label} hostname did not resolve to a routable public address`,
      'SSRF_BLOCKED',
    );
  }
  if (!records?.length || records.some((r) => isBlockedAddress(r.address))) {
    throw AppError.badRequest(
      `${label} resolves to a private/loopback/link-local address`,
      'SSRF_BLOCKED',
    );
  }
  return url;
}

export function assertSafeFeedUrl(rawUrl) {
  return assertSafeOutboundUrl(rawUrl);
}

export default { isBlockedAddress, assertSafeFeedUrl, assertSafeOutboundUrl };
