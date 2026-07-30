import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderInventory, validateInventory } from '../render.mjs';

function inventory(overrides = {}) {
  return {
    resolverA: { name: 'dns-a.hospital.example', address: '10.20.0.2' },
    resolverB: { name: 'dns-b.hospital.example', address: '10.20.0.3' },
    clinicalCidrs: ['10.30.0.0/24', '10.31.0.0/24'],
    nonClinicalCidrs: ['10.40.0.0/24', '10.41.0.0/24'],
    privateIpv4: '10.50.0.10',
    positiveTtlSeconds: 60,
    negativeTtlSeconds: 30,
    zoneSerial: 2026073001,
    hosts: ['api.vhhealth.app', 'north-api.vhhealth.app'],
    ...overrides,
  };
}

test('renders exact managed hosts and preserves a public catch-all view', () => {
  const output = mkdtempSync(join(tmpdir(), 'vh-c2-2-dns-'));
  try {
    renderInventory(inventory(), output);
    const config = readFileSync(join(output, 'named.conf.c2-2'), 'utf8');
    assert.match(config, /view "vhhealth-managed-clinical"/);
    assert.match(config, /view "vhhealth-public"/);
    assert.match(config, /! "vhhealth-managed-clinical"; any;/);
    assert.match(config, /zone "api\.vhhealth\.app"/);
    assert.match(config, /zone "north-api\.vhhealth\.app"/);
    assert.doesNotMatch(config, /\*/);

    const zoneFiles = readdirSync(join(output, 'zones')).sort();
    assert.deepEqual(zoneFiles, [
      'api.vhhealth.app.zone',
      'north-api.vhhealth.app.zone',
    ]);
    for (const file of zoneFiles) {
      const zone = readFileSync(join(output, 'zones', file), 'utf8');
      assert.match(zone, /@ IN A 10\.50\.0\.10/);
      assert.doesNotMatch(zone, /^(?!;).*\sAAAA\s/m);
      assert.match(zone, /authoritative zone returns\n; NODATA for AAAA/);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('rejects wildcard and non-onboarded host shapes', () => {
  assert.throws(
    () => validateInventory(inventory({ hosts: ['api.vhhealth.app', '*-api.vhhealth.app'] })),
    /must not contain a wildcard/,
  );
  assert.throws(
    () => validateInventory(inventory({ hosts: ['api.vhhealth.app', 'admin.vhhealth.app'] })),
    /explicit <slug>-api host/,
  );
});

test('rejects missing apex, duplicate hosts, and public VIPs', () => {
  assert.throws(
    () => validateInventory(inventory({ hosts: ['north-api.vhhealth.app'] })),
    /must include api\.vhhealth\.app/,
  );
  assert.throws(
    () => validateInventory(inventory({
      hosts: ['api.vhhealth.app', 'api.vhhealth.app'],
    })),
    /contains duplicates/,
  );
  assert.throws(
    () => validateInventory(inventory({ privateIpv4: '203.0.113.10' })),
    /RFC1918/,
  );
});

test('rejects overlapping clinical and guest or patient networks', () => {
  assert.throws(
    () => validateInventory(inventory({
      clinicalCidrs: ['10.30.0.0/24'],
      nonClinicalCidrs: ['10.30.0.128/25'],
    })),
    /CIDRs overlap/,
  );
});

test('requires two distinct redundant resolvers', () => {
  assert.throws(
    () => validateInventory(inventory({
      resolverB: { name: 'dns-b.hospital.example', address: '10.20.0.2' },
    })),
    /must be distinct/,
  );
});
