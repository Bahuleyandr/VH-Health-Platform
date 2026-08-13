// The canonical backend adapter registry is declared twice on purpose — once
// in JS (each protocol adapter's `canonicalBackendAdapterKeys`, aggregated by
// protocolAdapters/index.js) and once in SQL
// (`interop_canonical_backend_adapters()` in migration 670) — because
// interface-engine activation is enforced at BOTH the service boundary and the
// database triggers, and neither may be the weaker of the two.
//
// Two declarations can drift, so this test pins them to each other as an exact
// set, in both directions: registering a canonical adapter in JS without
// teaching the database about it fails here, and so does the reverse. That is
// the same guarantee externalInterfaceRecoveryCatalog.test.js provides for the
// I01-I30 adapter dispatch table.

import fs from 'node:fs';
import path from 'node:path';

import {
  CANONICAL_BACKEND_ADAPTER_KEYS,
  IMPLEMENTED_I05_PROTOCOLS,
  assertActivatableBackendAdapter,
  canonicalBackendAdapterKeysFor,
} from '../../services/interfaceEngine/protocolAdapters/index.js';
import { ACTIVE_CONNECTOR_PROTOCOLS } from '../../services/interfaceEngine/runtimePolicy.js';

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'src/migrations/670_interface_engine_canonical_adapter_activation.sql',
  ),
  'utf8',
);

// Parse the SQL CASE arms of interop_canonical_backend_adapters() into the
// same shape as the JS registry.
function parseSqlRegistry(sql) {
  const body = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.interop_canonical_backend_adapters'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.assert_interop_runtime_activation'),
  );
  const registry = {};
  const armPattern = /WHEN\s+'([a-z0-9_]+)'\s+THEN\s+ARRAY\[([^\]]*)\]/g;
  let match = armPattern.exec(body);
  while (match) {
    const [, protocol, rawKeys] = match;
    registry[protocol] = rawKeys
      .split(',')
      .map(entry => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    match = armPattern.exec(body);
  }
  return registry;
}

describe('interface-engine canonical backend adapter registry', () => {
  test('the JS registry and migration 670 declare the same canonical adapters', () => {
    const sqlRegistry = parseSqlRegistry(migration);
    expect(Object.keys(sqlRegistry).sort()).toEqual([...IMPLEMENTED_I05_PROTOCOLS].sort());
    for (const protocol of IMPLEMENTED_I05_PROTOCOLS) {
      expect(sqlRegistry[protocol].sort()).toEqual(
        [...CANONICAL_BACKEND_ADAPTER_KEYS[protocol]].sort(),
      );
    }
  });

  test('hl7v2 has no canonical backend adapter, so http_inbound activation is unavailable', () => {
    // The load-bearing fact behind the whole fix: http_inbound may only carry
    // hl7v2, and hl7v2's only registered backend adapter is the preview
    // adapter, which performs no clinical write and is forbidden at
    // activation. If this expectation ever changes, inbound activation opens —
    // deliberately, and only alongside a real adapter.
    expect(ACTIVE_CONNECTOR_PROTOCOLS.http_inbound).toEqual(['hl7v2']);
    expect(canonicalBackendAdapterKeysFor('hl7v2')).toEqual([]);
    expect(() => assertActivatableBackendAdapter({
      protocol: 'hl7v2',
      adapterKey: 'backend.interop.preview',
    })).toThrow(expect.objectContaining({
      code: 'INTEROP_CANONICAL_BACKEND_ADAPTER_UNAVAILABLE',
    }));
    // Absent and unregistered adapters are refused for the same reason.
    for (const adapterKey of [null, '', '   ', 'backend.interop.hl7v2', 'backend.interop.csv']) {
      expect(() => assertActivatableBackendAdapter({ protocol: 'hl7v2', adapterKey }))
        .toThrow(expect.objectContaining({
          code: 'INTEROP_CANONICAL_BACKEND_ADAPTER_UNAVAILABLE',
        }));
    }
  });

  test('refuses an absent or unregistered adapter for a protocol that does have one', () => {
    // csv/json/fhir_json/other DO record `receipt_status = 'accepted'`, so
    // their canonical key is activatable — but only that exact key, and only
    // when one is actually configured.
    expect(assertActivatableBackendAdapter({
      protocol: 'csv',
      adapterKey: 'backend.interop.csv',
    })).toBe('backend.interop.csv');
    expect(() => assertActivatableBackendAdapter({ protocol: 'csv', adapterKey: null }))
      .toThrow(expect.objectContaining({ code: 'INTEROP_BACKEND_ADAPTER_REQUIRED' }));
    expect(() => assertActivatableBackendAdapter({ protocol: 'csv', adapterKey: '   ' }))
      .toThrow(expect.objectContaining({ code: 'INTEROP_BACKEND_ADAPTER_REQUIRED' }));
    expect(() => assertActivatableBackendAdapter({
      protocol: 'csv',
      adapterKey: 'backend.interop.json',
    })).toThrow(expect.objectContaining({ code: 'INTEROP_BACKEND_ADAPTER_UNREGISTERED' }));
  });

  test('refuses a protocol with no registered adapter at all', () => {
    expect(() => assertActivatableBackendAdapter({
      protocol: 'mllp_binary',
      adapterKey: 'backend.interop.csv',
    })).toThrow(expect.objectContaining({ code: 'INTEROP_PROTOCOL_ADAPTER_UNREGISTERED' }));
  });

  test('migration 670 gates both activation triggers on the canonical registry', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.interop_canonical_backend_adapters');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.assert_interop_runtime_activation');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.assert_interop_channel_active_runtime');
    expect(migration).toContain('inbound activation is unavailable: no canonical backend adapter is registered for this protocol');
    expect(migration).toContain('active http_inbound versions require a registered canonical backend adapter');
    expect(migration).toContain('active http_inbound channels require a registered canonical backend adapter');
    // The pre-existing preview refusal must survive, not be replaced.
    expect(migration).toContain('preview-only inbound versions cannot be activated');
    // …and so must every other 665 activation rule that these two functions
    // carry, since CREATE OR REPLACE rewrites them wholesale.
    expect(migration).toContain('http_outbound runtime supports auth_kind none only');
    expect(migration).toContain('active http_outbound versions require an endpoint URL');
    expect(migration).toContain('http_inbound runtime requires tenant_interop_secret authentication and a sender identifier');
    expect(migration).toContain('active http_inbound versions require an active source with a non-empty IP allowlist');
    expect(migration).toContain('active http_inbound source allowlist contains an invalid IP or CIDR');
    expect(migration).toContain('interface-engine connector runtime is not implemented');
    expect(migration).toContain('active interface-engine channel must reference its active version');
  });
});
