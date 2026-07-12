// Regression guard for Sol Ultra audit #31: safeFetch followed redirects
// automatically. For an IP-literal (un-pinned) hop — and any hop where fetch's
// default redirect follow kicked in — a validated public host could 3xx to an
// internal/loopback/metadata target with no re-validation. safeFetch now forces
// manual redirects and re-runs the SSRF guard on every hop.
import { jest } from '@jest/globals';
import { safeFetch } from '../../utils/ssrfGuard.js';

function redirectResponse(location) {
  return { status: 302, headers: { get: (k) => (String(k).toLowerCase() === 'location' ? location : null) } };
}

describe('safeFetch redirect re-validation (Sol Ultra #31)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('blocks a redirect hop that targets loopback', async () => {
    global.fetch = jest.fn(async () => redirectResponse('http://127.0.0.1/internal'));
    await expect(safeFetch('http://8.8.8.8/start')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('blocks a redirect hop that targets a hex IPv4-mapped IPv6 loopback', async () => {
    global.fetch = jest.fn(async () => redirectResponse('http://[::ffff:7f00:1]/x'));
    await expect(safeFetch('http://8.8.8.8/start')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('returns a non-redirect response without an extra hop', async () => {
    global.fetch = jest.fn(async () => ({ status: 200, headers: { get: () => null } }));
    const res = await safeFetch('http://8.8.8.8/ok');
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
