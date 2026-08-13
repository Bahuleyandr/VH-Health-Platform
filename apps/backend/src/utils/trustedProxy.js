import net from 'node:net';

import { AppError } from './AppError.js';

// This must match proxy-real-ip-cidr in the public ingress-nginx ConfigMap.
export const TRUSTED_INGRESS_PROXY_CIDRS = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
]);

const ALTERNATE_CLIENT_IP_HEADERS = Object.freeze([
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'x-original-forwarded-for',
  'true-client-ip',
  'cf-connecting-ip',
]);

function normalizeIp(value) {
  let ip = String(value || '').trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && net.isIP(mapped[1]) === 4) ip = mapped[1];
  return net.isIP(ip) ? ip : null;
}

function ipv4Number(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((value, part) => ((value << 8) + part) >>> 0, 0);
}

function matchesIpv4Cidr(ip, cidr) {
  const [network, prefixText] = cidr.split('/');
  const address = ipv4Number(ip);
  const networkAddress = ipv4Number(network);
  const prefix = Number(prefixText);
  if (address == null || networkAddress == null || !Number.isInteger(prefix)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (networkAddress & mask);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  if (Object.hasOwn(headers, name)) return headers[name];
  const match = Object.keys(headers).find(key => key.toLowerCase() === name);
  return match ? headers[match] : undefined;
}

function headerPresent(headers, name) {
  const value = headerValue(headers, name);
  if (Array.isArray(value)) return value.some(item => String(item || '').trim());
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function isTrustedIngressProxy(value) {
  const ip = normalizeIp(value);
  if (!ip || net.isIP(ip) !== 4) return false;
  return TRUSTED_INGRESS_PROXY_CIDRS.some(cidr => matchesIpv4Cidr(ip, cidr));
}

export function resolveIngressClientIp(req) {
  const peerIp = normalizeIp(req?.socket?.remoteAddress);
  if (!peerIp) {
    throw AppError.forbidden(
      'Ingress source address could not be verified',
      'INGRESS_SOURCE_IP_REQUIRED',
    );
  }

  const forwarded = headerValue(req?.headers, 'x-forwarded-for');
  const forwardedProvided = forwarded !== undefined && forwarded !== null;
  const alternateProvided = ALTERNATE_CLIENT_IP_HEADERS.some(name => (
    headerPresent(req?.headers, name)
  ));
  if (!forwardedProvided && !alternateProvided) return peerIp;

  if (!isTrustedIngressProxy(peerIp)) {
    throw AppError.forbidden(
      'Forwarded source identity came from an untrusted proxy peer',
      'INGRESS_PROXY_UNTRUSTED',
    );
  }

  const values = Array.isArray(forwarded) ? forwarded : [forwarded];
  const forwardedText = values.length === 1 ? String(values[0] || '').trim() : '';
  if (!forwardedText || forwardedText.includes(',')) {
    throw AppError.forbidden(
      'Ingress proxy chain must provide one canonical client address',
      'INGRESS_PROXY_CHAIN_INVALID',
    );
  }
  const clientIp = normalizeIp(forwardedText);
  if (!clientIp) {
    throw AppError.forbidden(
      'Ingress proxy chain contains an invalid client address',
      'INGRESS_PROXY_CHAIN_INVALID',
    );
  }
  return clientIp;
}

export default Object.freeze({
  TRUSTED_INGRESS_PROXY_CIDRS,
  isTrustedIngressProxy,
  resolveIngressClientIp,
});
