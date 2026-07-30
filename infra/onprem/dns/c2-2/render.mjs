#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_APEX = 'api.vhhealth.app';
const TENANT_API_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-api\.vhhealth\.app$/;
const FQDN = /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/;

function fail(message) {
  throw new Error(`c2-2 dns inventory: ${message}`);
}

function ipv4ToInt(value) {
  return value
    .split('.')
    .reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function privateIpv4(value, field) {
  if (isIP(value) !== 4) fail(`${field} must be an IPv4 address`);
  const number = ipv4ToInt(value);
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (number & mask) === (ipv4ToInt(base) & mask);
  };
  if (
    !inRange('10.0.0.0', 8) &&
    !inRange('172.16.0.0', 12) &&
    !inRange('192.168.0.0', 16)
  ) {
    fail(`${field} must use an RFC1918 private address`);
  }
  return value;
}

function parseCidr(value, field) {
  if (typeof value !== 'string') fail(`${field} must be a CIDR string`);
  const [address, rawPrefix, ...extra] = value.split('/');
  const prefix = Number(rawPrefix);
  if (extra.length || isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) {
    fail(`${field} must be an IPv4 CIDR with prefix 8..32`);
  }
  privateIpv4(address, field);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = ipv4ToInt(address) & mask;
  const size = 2 ** (32 - prefix);
  return { value, start, end: start + size - 1 };
}

function overlaps(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function positiveInteger(value, field, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    fail(`${field} must be an integer between 1 and ${max}`);
  }
  return number;
}

function resolver(value, field) {
  if (!value || typeof value !== 'object') fail(`${field} is required`);
  const name = String(value.name ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!FQDN.test(name)) fail(`${field}.name must be a valid FQDN`);
  return {
    name: `${name}.`,
    address: privateIpv4(String(value.address ?? ''), `${field}.address`),
  };
}

export function validateInventory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('root must be an object');
  }
  const resolverA = resolver(raw.resolverA, 'resolverA');
  const resolverB = resolver(raw.resolverB, 'resolverB');
  if (resolverA.name === resolverB.name || resolverA.address === resolverB.address) {
    fail('resolverA and resolverB must be distinct');
  }

  const parseCidrs = (value, field) => {
    if (!Array.isArray(value) || value.length === 0) fail(`${field} must not be empty`);
    const parsed = value.map((entry, index) => parseCidr(entry, `${field}[${index}]`));
    if (new Set(parsed.map(entry => entry.value)).size !== parsed.length) {
      fail(`${field} contains duplicates`);
    }
    return parsed;
  };
  const clinicalCidrs = parseCidrs(raw.clinicalCidrs, 'clinicalCidrs');
  const nonClinicalCidrs = parseCidrs(raw.nonClinicalCidrs, 'nonClinicalCidrs');
  for (const clinical of clinicalCidrs) {
    for (const nonClinical of nonClinicalCidrs) {
      if (overlaps(clinical, nonClinical)) {
        fail(`clinical and non-clinical CIDRs overlap: ${clinical.value} / ${nonClinical.value}`);
      }
    }
  }

  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    fail('hosts must not be empty');
  }
  const hosts = raw.hosts.map((value, index) => {
    const host = String(value).trim().toLowerCase().replace(/\.$/, '');
    if (host.includes('*')) fail(`hosts[${index}] must not contain a wildcard`);
    if (host !== API_APEX && !TENANT_API_HOST.test(host)) {
      fail(`hosts[${index}] must be api.vhhealth.app or an explicit <slug>-api host`);
    }
    return host;
  });
  if (!hosts.includes(API_APEX)) fail(`hosts must include ${API_APEX}`);
  if (new Set(hosts).size !== hosts.length) fail('hosts contains duplicates');

  return {
    resolverA,
    resolverB,
    clinicalCidrs,
    nonClinicalCidrs,
    privateIpv4: privateIpv4(String(raw.privateIpv4 ?? ''), 'privateIpv4'),
    positiveTtlSeconds: positiveInteger(raw.positiveTtlSeconds, 'positiveTtlSeconds', 86400),
    negativeTtlSeconds: positiveInteger(raw.negativeTtlSeconds, 'negativeTtlSeconds', 86400),
    zoneSerial: positiveInteger(raw.zoneSerial, 'zoneSerial', 4294967295),
    hosts: [...hosts].sort(),
  };
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in values)) fail(`template value ${key} is missing`);
    return String(values[key]);
  });
}

export function renderInventory(raw, outputDirectory) {
  const inventory = validateInventory(raw);
  const target = resolve(outputDirectory);
  const zonesDirectory = join(target, 'zones');
  mkdirSync(zonesDirectory, { recursive: true });

  const zoneTemplate = readFileSync(
    join(__dirname, 'templates', 'private-host.zone.tmpl'),
    'utf8',
  );
  const declarations = [];
  for (const host of inventory.hosts) {
    const zoneFile = `${host}.zone`;
    const rendered = fill(zoneTemplate, {
      POSITIVE_TTL: inventory.positiveTtlSeconds,
      RESOLVER_A_NAME: inventory.resolverA.name,
      RESOLVER_B_NAME: inventory.resolverB.name,
      ZONE_SERIAL: inventory.zoneSerial,
      NEGATIVE_TTL: inventory.negativeTtlSeconds,
      PRIVATE_IPV4: inventory.privateIpv4,
    });
    writeFileSync(join(zonesDirectory, zoneFile), rendered, { flag: 'wx' });
    declarations.push(
      `  zone "${host}" { type primary; file "${join(zonesDirectory, zoneFile).replaceAll('\\', '/')}"; };`,
    );
  }

  const viewTemplate = readFileSync(
    join(__dirname, 'templates', 'named.conf.views.tmpl'),
    'utf8',
  );
  const renderedViews = fill(viewTemplate, {
    CLINICAL_CIDRS: inventory.clinicalCidrs.map(cidr => `  ${cidr.value};`).join('\n'),
    NONCLINICAL_CIDRS: inventory.nonClinicalCidrs.map(cidr => `  ${cidr.value};`).join('\n'),
    ZONE_DECLARATIONS: declarations.join('\n'),
  });
  writeFileSync(join(target, 'named.conf.c2-2'), renderedViews, { flag: 'wx' });
  writeFileSync(
    join(target, 'render-receipt.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      resolvers: [inventory.resolverA, inventory.resolverB],
      privateIpv4: inventory.privateIpv4,
      zoneSerial: inventory.zoneSerial,
      hosts: inventory.hosts,
    }, null, 2)}\n`,
    { flag: 'wx' },
  );
  return { target, inventory };
}

function main() {
  const [, , inputPath, outputDirectory] = process.argv;
  if (!inputPath || !outputDirectory) {
    console.error(`Usage: node ${basename(process.argv[1])} <inventory.json> <empty-output-directory>`);
    process.exitCode = 2;
    return;
  }
  const raw = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  const result = renderInventory(raw, outputDirectory);
  console.log(`c2-2 dns: rendered ${result.inventory.hosts.length} exact zones -> ${result.target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
