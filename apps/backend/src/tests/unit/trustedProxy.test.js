import fs from 'node:fs';
import path from 'node:path';

import {
  isTrustedIngressProxy,
  resolveIngressClientIp,
} from '../../utils/trustedProxy.js';

function requestWith({ remoteAddress = '::ffff:127.0.0.1', headers = {} } = {}) {
  return {
    socket: { remoteAddress },
    headers,
  };
}

describe('trusted ingress proxy identity', () => {
  test('is the Express-wide trust proxy predicate', () => {
    const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/app.js'), 'utf8');
    expect(appSource).toContain("app.set('trust proxy', isTrustedIngressProxy)");
  });

  test('trusts only the private proxy peers documented by the ingress manifests', () => {
    expect(isTrustedIngressProxy('10.20.30.40')).toBe(true);
    expect(isTrustedIngressProxy('172.16.10.5')).toBe(true);
    expect(isTrustedIngressProxy('192.168.2.7')).toBe(true);
    expect(isTrustedIngressProxy('127.0.0.1')).toBe(false);
    expect(isTrustedIngressProxy('203.0.113.9')).toBe(false);
  });

  test('preserves direct local requests but rejects a spoofed forwarding chain', () => {
    expect(resolveIngressClientIp(requestWith())).toBe('127.0.0.1');
    expect(() => resolveIngressClientIp(requestWith({
      headers: { 'x-forwarded-for': '127.0.0.1' },
    }))).toThrow(expect.objectContaining({ code: 'INGRESS_PROXY_UNTRUSTED' }));
  });

  test('accepts exactly one canonical address from a trusted ingress peer', () => {
    expect(resolveIngressClientIp(requestWith({
      remoteAddress: '10.42.1.8',
      headers: {
        'x-forwarded-for': '203.0.113.24',
        'cf-connecting-ip': '203.0.113.24',
      },
    }))).toBe('203.0.113.24');
    expect(() => resolveIngressClientIp(requestWith({
      remoteAddress: '10.42.1.8',
      headers: { 'x-forwarded-for': '198.51.100.2, 203.0.113.24' },
    }))).toThrow(expect.objectContaining({ code: 'INGRESS_PROXY_CHAIN_INVALID' }));
    expect(() => resolveIngressClientIp(requestWith({
      remoteAddress: '10.42.1.8',
      headers: { 'x-real-ip': '203.0.113.24' },
    }))).toThrow(expect.objectContaining({ code: 'INGRESS_PROXY_CHAIN_INVALID' }));
  });
});
