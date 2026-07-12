import { jest } from '@jest/globals';
import http from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';

// M17 (audit 2026-06-22): close the SSRF DNS-rebind TOCTOU. The old guard
// validated a hostname's resolved IPs, then the caller's fetch() re-resolved
// independently — an attacker-controlled DNS could answer public on the check
// and internal (169.254.169.254 / 127.0.0.1) on the fetch. safeFetch validates
// AND pins the socket to the validated addresses so the connection cannot
// re-resolve. These tests cover: the resolve-returns-addresses contract, the
// pinned lookup, the dispatcher actually routing to the pinned IP, and the
// safeFetch wiring/branching.

// Mock node:dns/promises so resolveSafeOutboundTarget sees controlled records.
const lookupMock = jest.fn();
jest.unstable_mockModule('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));

const {
  resolveSafeOutboundTarget,
  makePinnedLookup,
  buildPinnedDispatcher,
  safeFetch,
  isBlockedAddress,
  _transport,
} = await import('../../utils/ssrfGuard.js');

const PUBLIC_V4 = '93.184.216.34'; // example.com — publicly routable

beforeEach(() => {
  lookupMock.mockReset();
});

// Invoke a node-style lookup(hostname, options, cb) as a promise.
function invokeLookup(lk, hostname, options) {
  return new Promise((resolve, reject) => {
    lk(hostname, options, (err, address, family) => {
      if (err) reject(err);
      else resolve(options && options.all ? address : [address, family]);
    });
  });
}

describe('resolveSafeOutboundTarget — returns the validated, pinnable resolution', () => {
  it('returns the resolved public addresses for a DNS host', async () => {
    lookupMock.mockResolvedValueOnce([{ address: PUBLIC_V4, family: 4 }]);
    const { url, addresses } = await resolveSafeOutboundTarget('https://feed.example.com/hl7');
    expect(url.hostname).toBe('feed.example.com');
    expect(addresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it('returns NO addresses for an IP-literal host (nothing to pin, no DNS)', async () => {
    const { addresses } = await resolveSafeOutboundTarget(`https://${PUBLIC_V4}/x`);
    expect(addresses).toEqual([]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws SSRF_BLOCKED when the DNS host resolves to a blocked address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]); // cloud metadata
    await expect(resolveSafeOutboundTarget('https://rebind.example.com/'))
      .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('throws SSRF_BLOCKED when ANY of several resolved addresses is blocked', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: PUBLIC_V4, family: 4 },
      { address: '10.0.0.5', family: 4 }, // RFC1918 — one bad apple fails closed
    ]);
    await expect(resolveSafeOutboundTarget('https://mixed.example.com/'))
      .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('throws SSRF_BLOCKED for an IP-literal loopback host', async () => {
    await expect(resolveSafeOutboundTarget('http://127.0.0.1/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('throws SSRF_BLOCKED for a non-http scheme, embedded creds, and a malformed URL', async () => {
    await expect(resolveSafeOutboundTarget('file:///etc/passwd')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(resolveSafeOutboundTarget('https://user:pw@example.com/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(resolveSafeOutboundTarget('not a url')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('fails closed when DNS resolution itself errors', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(resolveSafeOutboundTarget('https://nxdomain.example.com/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
});

describe('makePinnedLookup — ignores the hostname, returns ONLY the pinned addresses', () => {
  it('returns the single pinned address regardless of the hostname argument', async () => {
    const lk = makePinnedLookup([{ address: PUBLIC_V4, family: 4 }]);
    await expect(invokeLookup(lk, 'attacker-rebind.invalid', {})).resolves.toEqual([PUBLIC_V4, 4]);
  });

  it('returns all pinned addresses when options.all is set', async () => {
    const lk = makePinnedLookup([{ address: PUBLIC_V4, family: 4 }, { address: '1.1.1.1', family: 4 }]);
    await expect(invokeLookup(lk, 'whatever.invalid', { all: true }))
      .resolves.toEqual([{ address: PUBLIC_V4, family: 4 }, { address: '1.1.1.1', family: 4 }]);
  });

  it('fails closed when the pinned set is empty', async () => {
    const lk = makePinnedLookup([]);
    await expect(invokeLookup(lk, 'h.invalid', {})).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('fails closed when every pinned address is (now) blocked', async () => {
    // Defensive: a pinned address that is loopback/private is dropped → empty → error.
    const lk = makePinnedLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(invokeLookup(lk, 'h.invalid', {})).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
  });
});

describe('the connection goes to the pinned IP, not DNS', () => {
  let server;
  let port;
  let lastHostHeader;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastHostHeader = req.headers.host;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pinned-ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('buildPinnedDispatcher returns an undici Agent', () => {
    expect(buildPinnedDispatcher([{ address: PUBLIC_V4, family: 4 }])).toBeInstanceOf(Agent);
  });

  it('undici honours connect.lookup — pinning the lookup pins the socket (the mechanism safeFetch relies on)', async () => {
    // An undici Agent whose connector lookup ALWAYS returns 127.0.0.1 (the raw
    // mechanism buildPinnedDispatcher uses; here unfiltered so we can target the
    // in-test loopback server — buildPinnedDispatcher itself would correctly
    // refuse a loopback pin, which is exactly what the makePinnedLookup
    // fail-closed tests above assert). The hostname does not exist in DNS, so
    // reaching our server proves the socket followed the pinned lookup and
    // could not re-resolve to anything else.
    // Honour the node dns.lookup `all` contract (Node 22 net.connect uses
    // autoSelectFamily ⇒ calls lookup with { all: true } expecting an array) —
    // exactly the shape makePinnedLookup produces.
    const rawLookup = (_h, o, cb) => (o && o.all
      ? cb(null, [{ address: '127.0.0.1', family: 4 }])
      : cb(null, '127.0.0.1', 4));
    const agent = new Agent({ connect: { lookup: rawLookup } });
    const res = await undiciFetch(`http://nonexistent-rebind-target.invalid:${port}/x`, { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pinned-ok');
    // SNI/Host stays the original hostname (so HTTPS cert validation is intact).
    expect(lastHostHeader).toBe(`nonexistent-rebind-target.invalid:${port}`);
    await agent.close();
  });
});

describe('safeFetch — validates then pins the dispatcher', () => {
  it('passes a pinned dispatcher to fetch for a DNS host', async () => {
    lookupMock.mockResolvedValueOnce([{ address: PUBLIC_V4, family: 4 }]);
    const fetchSpy = jest.spyOn(_transport, 'fetch').mockResolvedValue({ ok: true, status: 200 });
    try {
      await safeFetch('https://feed.example.com/push', { method: 'POST', body: 'x' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(String(calledUrl)).toContain('feed.example.com');
      expect(init.method).toBe('POST');
      expect(init.dispatcher).toBeDefined(); // ← pinned to the validated IP
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does NOT attach a dispatcher for an IP-literal host (no DNS to rebind)', async () => {
    const fetchSpy = jest.spyOn(_transport, 'fetch').mockResolvedValue({ ok: true, status: 200 });
    try {
      await safeFetch(`https://${PUBLIC_V4}/x`, {});
      const [, init] = fetchSpy.mock.calls[0];
      expect(init.dispatcher).toBeUndefined();
      expect(lookupMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects an unsafe URL with SSRF_BLOCKED before any fetch', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }]);
    const fetchSpy = jest.spyOn(_transport, 'fetch').mockResolvedValue({ ok: true, status: 200 });
    try {
      await expect(safeFetch('https://internal.example.com/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
