// Regression tests for audit finding H4 (2026-06-10) — SSRF in HL7 outbound
// feed delivery. Before the fix, createSubscription validated only the URL
// scheme and deliverOne fetched the stored URL server-side with an
// attacker-chosen Authorization header; nothing blocked loopback, RFC-1918,
// or the cloud metadata endpoint.
//
// Proves:
//   1. isBlockedAddress classifies loopback/private/link-local/metadata/ULA
//      addresses as blocked and public addresses as allowed.
//   2. assertSafeFeedUrl rejects unsafe URLs (IP literals AND DNS names that
//      resolve to blocked ranges, e.g. localhost) and unresolvable hosts
//      (fail closed — covers internal cluster Service DNS names).
//   3. createSubscription refuses unsafe endpoints.
//   4. deliverPendingFeedMessages re-checks at delivery time: a poisoned
//      subscription row (inserted directly in SQL, simulating a legacy row or
//      DNS-rebound host) is NEVER fetched — a live local HTTP server proves
//      no request arrives — and the message is marked failed with SSRF error.
//   5. The host allowlist (HL7_FEED_HOST_ALLOWLIST) restricts hosts when set.

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { isBlockedAddress, assertSafeFeedUrl } from '../utils/ssrfGuard.js';
import {
  createSubscription,
  deliverPendingFeedMessages,
} from '../services/hl7/hl7OutboundService.js';

const SUB_NAME = 'h4-ssrf-test-subscription';
const TENANT_ID = randomUUID();
const SUFFIX = TENANT_ID.slice(0, 8);

describe('H4 — SSRF guard', () => {
  beforeAll(async () => {
    // Other suites (hl7-outbound.deep) set the test-only escape hatch; this
    // suite tests the guard itself, so it must be OFF here.
    delete process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS;
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'H4 SSRF HL7 test tenant')`,
      TENANT_ID, `h4-ssrf-hl7-${SUFFIX}`,
    );
  });
  afterEach(() => {
    delete process.env.HL7_FEED_HOST_ALLOWLIST;
    delete process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS;
  });

  describe('test-only escape hatch is refused in production', () => {
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    test('HL7_FEED_ALLOW_PRIVATE_TARGETS=true is IGNORED when NODE_ENV=production', async () => {
      process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS = 'true';
      process.env.NODE_ENV = 'production';
      await expect(assertSafeFeedUrl('http://127.0.0.1:9999/feed'))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });

    test('escape hatch works outside production (test infrastructure only)', async () => {
      process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS = 'true';
      await expect(assertSafeFeedUrl('http://127.0.0.1:9999/feed')).resolves.toBeTruthy();
    });
  });

  describe('isBlockedAddress (pure)', () => {
    test.each([
      '127.0.0.1', '127.8.8.8',          // loopback
      '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC-1918
      '169.254.169.254', '169.254.0.1',  // link-local + cloud metadata
      '100.64.0.1',                       // CGNAT
      '0.0.0.0', '255.255.255.255',       // unspecified / broadcast
      '224.0.0.1',                        // multicast
      '::1', '::',                        // v6 loopback / unspecified
      'fc00::1', 'fd12:3456::1',          // ULA
      'fe80::1',                          // v6 link-local
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', // v4-mapped
      'not-an-ip',                        // unparsable ⇒ blocked
    ])('blocks %s', (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    });

    test.each(['8.8.8.8', '1.1.1.1', '203.0.114.7', '2606:4700::1111'])(
      'allows public %s',
      (ip) => {
        expect(isBlockedAddress(ip)).toBe(false);
      },
    );
  });

  describe('assertSafeFeedUrl', () => {
    test.each([
      'http://127.0.0.1:8080/feed',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/feed',
      'http://192.168.1.20/feed',
      'http://[::1]/feed',
      'http://localhost/feed',                       // DNS name → loopback
      'http://postgres.vh-health.svc.cluster.local/', // unresolvable internal Service DNS ⇒ fail closed
      'ftp://example.com/feed',                       // bad scheme
      'http://user:pass@example.com/feed',            // embedded credentials
      'not a url',
    ])('rejects %s', async (url) => {
      await expect(assertSafeFeedUrl(url)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });

    test('accepts a public IP literal', async () => {
      await expect(assertSafeFeedUrl('https://8.8.8.8/feed')).resolves.toBeTruthy();
    });

    test('allowlist: non-listed host rejected, listed host checked normally', async () => {
      process.env.HL7_FEED_HOST_ALLOWLIST = 'feeds.partner-his.example';
      await expect(assertSafeFeedUrl('https://8.8.8.8/feed'))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      // Listed but unresolvable host still fails closed at the DNS step —
      // the allowlist narrows, it never bypasses the address checks.
      await expect(assertSafeFeedUrl('https://feeds.partner-his.example/feed'))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });
  });

  describe('createSubscription', () => {
    test.each([
      'http://127.0.0.1:9999/hl7',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/hl7',
      'http://localhost:9999/hl7',
    ])('refuses unsafe endpoint %s', async (endpointUrl) => {
      await expect(
        createSubscription({ tenantId: TENANT_ID, name: SUB_NAME, endpointUrl }),
      ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });
  });

  describe('delivery-time re-check (DNS rebinding / poisoned row defence)', () => {
    test('a stored loopback URL is never fetched and the message fails with SSRF error', async () => {
      // Live local server proves no request arrives.
      let hits = 0;
      const server = http.createServer((req, res) => { hits += 1; res.end('ok'); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        // Insert the subscription directly in SQL — simulating a legacy row
        // created before the guard, or a host that re-resolved to an internal
        // address after create-time validation passed.
        const subRows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
          // Pin is_active TRUE explicitly so the delivery JOIN
          // (s.id = m.subscription_id AND s.is_active) always matches this row,
          // independent of any column default.
          `INSERT INTO hl7_feed_subscriptions
             (tenant_id, name, endpoint_url, auth_header, message_types, is_active)
           VALUES ($1::uuid, $2, $3, 'Bearer attacker-controlled',
                   ARRAY['ADT^A01']::text[], TRUE)
           RETURNING id`,
          TENANT_ID, `${SUB_NAME}-poisoned-${SUFFIX}`, `http://127.0.0.1:${port}/internal`,
        ));
        const subId = subRows[0].id;
        const payload = 'MSH|^~\\&|VH|VH|||20260610||ADT^A01|H4TEST1|P|2.5';
        const msgRows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
          // Pin status 'queued' + next_attempt_at in the past so the message is
          // unambiguously due for the delivery pass.
          `INSERT INTO hl7_outbound_messages
             (tenant_id, subscription_id, message_type, message_control_id,
              hl7_payload, status, next_attempt_at, source_event_key,
              payload_sha256)
           VALUES ($1::uuid, $2::integer, 'ADT^A01', 'H4TEST1', $3::text,
                   'queued', NOW() - INTERVAL '1 second', $4::text, $5::char(64))
           RETURNING id`,
          TENANT_ID, subId, payload, `h4-ssrf:${SUFFIX}`,
          createHash('sha256').update(payload, 'utf8').digest('hex'),
        ));
        const msgId = msgRows[0].id;

        // Run the tenant-scoped delivery pass until this message is held with
        // durable transport evidence. No automatic retry is authorized.
        let after;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await deliverPendingFeedMessages({ limit: 50, tenantId: TENANT_ID });
          after = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
            `SELECT status, last_error
               FROM hl7_outbound_messages
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            TENANT_ID, msgId,
          ));
          if (after[0].last_error) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(after[0].status).not.toBe('sent');
        expect(String(after[0].last_error)).toContain('SSRF_BLOCKED');
        expect(hits).toBe(0); // the local server was never contacted
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
