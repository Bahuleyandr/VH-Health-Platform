// Regression guard for Sol Ultra audit #35: IPv4-mapped IPv6 literals in
// HEX form (e.g. ::ffff:7f00:1 == 127.0.0.1) bypassed the SSRF private-address
// guard, because isBlockedIpv6 only matched a dotted-decimal embedded IPv4.
// Node's URL parser canonicalizes [::ffff:127.0.0.1] to [::ffff:7f00:1], so the
// hex form is the one that actually reaches the guard.
import { isBlockedAddress } from '../../utils/ssrfGuard.js';

describe('ssrfGuard IPv4-mapped IPv6 (Sol Ultra #35)', () => {
  it('blocks hex-encoded IPv4-mapped loopback (::ffff:7f00:1 == 127.0.0.1)', () => {
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
  });

  it('blocks hex-encoded IPv4-mapped RFC1918 (::ffff:c0a8:1 == 192.168.0.1)', () => {
    expect(isBlockedAddress('::ffff:c0a8:1')).toBe(true);
  });

  it('blocks hex-encoded IPv4-mapped metadata (::ffff:a9fe:a9fe == 169.254.169.254)', () => {
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('blocks NAT64 well-known-prefix loopback (64:ff9b::7f00:1)', () => {
    expect(isBlockedAddress('64:ff9b::7f00:1')).toBe(true);
  });

  it('still blocks dotted-decimal IPv4-mapped loopback (::ffff:127.0.0.1)', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('does NOT over-block a public IPv4-mapped address (::ffff:8.8.8.8)', () => {
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('does NOT over-block a routable public IPv6 (2606:4700:4700::1111)', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('still blocks unspecified/loopback/link-local/ULA/multicast IPv6', () => {
    for (const a of ['::', '::1', 'fe80::1', 'fc00::1', 'ff02::1']) {
      expect(isBlockedAddress(a)).toBe(true);
    }
  });
});
