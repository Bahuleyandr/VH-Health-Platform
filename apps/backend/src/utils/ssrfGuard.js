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

// Expand an IPv6 literal (incl. `::` compression and a trailing dotted-decimal
// IPv4) into its 8 16-bit groups. Returns null for a malformed literal.
function ipv6ToGroups(ip) {
  let s = String(ip).toLowerCase().trim();
  // Fold a trailing dotted-decimal IPv4 (::ffff:127.0.0.1) into two hextets so
  // the whole address is uniform hex before splitting.
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const b = dotted.slice(1).map((n) => Number.parseInt(n, 10));
    if (b.some((n) => n > 255)) return null;
    s = s.slice(0, dotted.index)
      + (((b[0] << 8) | b[1]).toString(16)) + ':' + (((b[2] << 8) | b[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? 0 : Number.parseInt(g, 16)));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

// The embedded IPv4 (dotted string) of a v4-mapped (::ffff:0:0/96) or NAT64
// well-known (64:ff9b::/96) IPv6 address — regardless of hex-vs-dotted spelling
// — else null. Sol Ultra #35: Node canonicalizes ::ffff:127.0.0.1 to the HEX
// form ::ffff:7f00:1, which the old dotted-only regex missed, so a loopback /
// RFC1918 / metadata target sailed through as an "opaque public IPv6".
function embeddedIpv4(ip) {
  const g = ipv6ToGroups(ip);
  if (!g) return null;
  const zeroHi = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0;
  const isV4Mapped = zeroHi && g[4] === 0 && g[5] === 0xffff;        // ::ffff:0:0/96
  const isNat64 = g[0] === 0x64 && g[1] === 0xff9b
    && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;         // 64:ff9b::/96
  if (!isV4Mapped && !isNat64) return null;
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
}

function isBlockedIpv6(ip) {
  const lower = String(ip).toLowerCase();
  // v4-mapped / NAT64 embedded IPv4 — normalize (dotted OR hex) and apply the
  // IPv4 policy (Sol Ultra #35).
  const v4 = embeddedIpv4(lower);
  if (v4) return isBlockedIpv4(v4);
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
const SSRF_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SSRF_MAX_REDIRECTS = 5;

export async function safeFetch(rawUrl, fetchOptions = {}, guardOptions = {}) {
  // Redirects are the SSRF hole (Sol Ultra #31): a validated public host — or an
  // IP-literal host on the un-pinned plain-fetch branch — could 3xx to an
  // internal/loopback/metadata target and `fetch`'s automatic redirect follow
  // would connect there with NO re-validation and NO socket pinning. So force
  // MANUAL redirect handling (the caller cannot override it) and re-run the full
  // guard on every hop, pinning each hop's own validated addresses.
  let current = String(rawUrl);
  let method = fetchOptions.method;
  let body = fetchOptions.body;

  for (let hop = 0; hop <= SSRF_MAX_REDIRECTS; hop += 1) {
    const { url, addresses } = await resolveSafeOutboundTarget(current, guardOptions);
    const agent = addresses.length ? buildPinnedDispatcher(addresses) : null;
    const perHop = { ...fetchOptions, method, body, redirect: 'manual' };
    if (agent) perHop.dispatcher = agent; else delete perHop.dispatcher;

    let response;
    try {
      response = await fetch(url, perHop);
    } catch (err) {
      if (agent) agent.close().catch(() => agent.destroy().catch(() => {}));
      throw err;
    }
    // Graceful close waits for the in-flight body before freeing the socket.
    if (agent) agent.close().catch(() => agent.destroy().catch(() => {}));

    if (!SSRF_REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response; // 3xx without Location — hand back as-is.

    // Resolve the next hop relative to the current URL, then loop to re-validate.
    current = new URL(location, url).toString();
    // 301/302/303 turn a POST into a bodyless GET (web-compat); 307/308 preserve
    // method + body.
    if (response.status !== 307 && response.status !== 308) {
      method = 'GET';
      body = undefined;
    }
  }
  throw AppError.badRequest('Too many redirects on outbound request', 'SSRF_BLOCKED');
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
