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
import { Agent } from 'undici';
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
 * Validate an outbound URL AND return the exact set of public addresses it
 * resolved to, so the *connection* can be pinned to that same resolution
 * (closing the DNS-rebinding TOCTOU — audit M17). Throws AppError (400-class,
 * code SSRF_BLOCKED) when the URL is unsafe.
 *
 * @returns {Promise<{ url: URL, addresses: Array<{address:string, family:number}> }>}
 *   `addresses` is the validated, pinnable resolution. It is EMPTY when there
 *   is nothing to pin — an IP-literal host (the connection already targets a
 *   verified literal, no DNS in the loop) or the test-only private hatch.
 */
export async function resolveSafeOutboundTarget(rawUrl, {
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
    return { url, addresses: [] }; // test-only; impossible in production (see above)
  }

  // IP-literal host: check directly, no DNS involved. Nothing to pin — the
  // connection will dial the literal we just verified.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw AppError.badRequest(
        `${label} targets a private/loopback/link-local address`,
        'SSRF_BLOCKED',
      );
    }
    return { url, addresses: [] };
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
  // Return the validated addresses so the caller can pin the socket to them.
  return { url, addresses: records.map((r) => ({ address: r.address, family: r.family })) };
}

/**
 * Validates an outbound feed URL. Throws AppError (400-class, code
 * SSRF_BLOCKED) when the URL is unsafe; resolves with the parsed URL
 * otherwise. MUST be called both at subscription-create AND immediately
 * before every delivery fetch (DNS-rebinding defence).
 *
 * NOTE: validate-only. It does NOT pin the connection, so a caller that
 * validates with this and then `fetch()`es by hostname still has a (small)
 * DNS-rebind window between the two independent resolutions. For the actual
 * delivery fetch use {@link safeFetch}, which validates AND pins atomically.
 */
export async function assertSafeOutboundUrl(rawUrl, opts = {}) {
  const { url } = await resolveSafeOutboundTarget(rawUrl, opts);
  return url;
}

export function assertSafeFeedUrl(rawUrl) {
  return assertSafeOutboundUrl(rawUrl);
}

/**
 * Build a `dns.lookup`-compatible function that resolves EVERY hostname to the
 * supplied pre-validated addresses and nothing else. Handed to an undici
 * connector so the TCP connection cannot re-resolve to an address the SSRF
 * guard never saw. Re-asserts each pinned address is still routable (defensive;
 * they were validated moments ago) and fails closed otherwise.
 */
export function makePinnedLookup(addresses) {
  const safe = (addresses || []).filter((a) => a && !isBlockedAddress(a.address));
  return (hostname, options, callback) => {
    // `options`/`callback` follow node's dns.lookup contract; undici may call
    // with (hostname, options, cb) and reads options.all.
    if (!safe.length) {
      const err = Object.assign(
        new Error('SSRF_BLOCKED: no safe pinned address for outbound connection'),
        { code: 'SSRF_BLOCKED' },
      );
      callback(err);
      return;
    }
    if (options && options.all) {
      callback(null, safe.map((a) => ({ address: a.address, family: a.family })));
    } else {
      callback(null, safe[0].address, safe[0].family);
    }
  };
}

/**
 * An undici dispatcher whose socket layer is pinned to `addresses`. Use as the
 * `dispatcher` of a single `fetch()`; close it (graceful) once the response is
 * in flight so the socket frees after the body completes.
 */
export function buildPinnedDispatcher(addresses) {
  return new Agent({ connect: { lookup: makePinnedLookup(addresses) } });
}

/**
 * The ONE outbound fetch for every user/operator-supplied URL (HL7 feeds,
 * webhooks, ABDM data-push). It validates the URL AND pins the TCP connection
 * to the addresses that validation resolved — so a DNS-rebinding host cannot
 * pass the check on a public IP and then have `fetch()` re-resolve to an
 * internal one (audit M17 TOCTOU). TLS SNI / cert validation and the Host
 * header still use the original hostname, so HTTPS is unaffected.
 *
 * Throws AppError SSRF_BLOCKED for an unsafe URL (same contract as
 * assertSafeOutboundUrl); otherwise returns the `fetch` Response.
 *
 * @param {string} rawUrl
 * @param {RequestInit} [fetchOptions] passed through to `fetch` (method, headers, body, signal…)
 * @param {object} [guardOptions] { label, allowlistEnv, allowPrivateEnv }
 */
export async function safeFetch(rawUrl, fetchOptions = {}, guardOptions = {}) {
  const { url, addresses } = await resolveSafeOutboundTarget(rawUrl, guardOptions);
  if (!addresses.length) {
    // IP-literal host (already a verified literal) or the test-private hatch —
    // no DNS in the loop, nothing to rebind; a plain fetch is safe.
    return fetch(url, fetchOptions);
  }
  const agent = buildPinnedDispatcher(addresses);
  try {
    const response = await fetch(url, { ...fetchOptions, dispatcher: agent });
    // Graceful close waits for the in-flight request (incl. the streaming body)
    // to finish before tearing the socket down, then frees it — no leak, no
    // truncated body. Fire-and-forget so we don't block returning the response.
    agent.close().catch(() => agent.destroy().catch(() => {}));
    return response;
  } catch (err) {
    agent.close().catch(() => agent.destroy().catch(() => {}));
    throw err;
  }
}

export default {
  isBlockedAddress,
  assertSafeFeedUrl,
  assertSafeOutboundUrl,
  resolveSafeOutboundTarget,
  makePinnedLookup,
  buildPinnedDispatcher,
  safeFetch,
};
