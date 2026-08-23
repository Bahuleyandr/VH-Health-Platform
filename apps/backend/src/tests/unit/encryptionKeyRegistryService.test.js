/**
 * Phase E3 — encryptionKeyRegistryService unit tests.
 *
 * `encryption_keys` is one table holding four different kinds of row, and this
 * console owns exactly one of them. The fixtures below stand for all four, with
 * the discriminators and status requirements taken from the code that actually
 * consumes each class:
 *
 *  - registry metadata — inert; nothing reads its status.
 *  - per-tenant envelope KEK — services/security/tenantKekProvider.js;
 *    `preloadAllTenantKeks()` re-registers the `status='active'` rows that still
 *    hold `wrapped_key_material` at every startup.
 *  - clinical-continuity policy / pack signing keys — migration 600 raises
 *    23514 on policy-version writes (600:1071-1109) and refuses pack
 *    publication outright unless the row is `status='active'` (600:1315-1334).
 *  - incident-packet signing keys — migration 630's
 *    `clinical_continuity_issue_incident_packet` fails closed unless the row is
 *    `Ed25519` + `status='active'` (630:718-723).
 *
 * The fake table hides / refuses a row ONLY when the statement actually carries
 * the allowlist, so a service that forgets it sees the live row exactly as
 * production would.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  __testing__,
  classifyEncryptionKeyRow,
  listEncryptionKeys,
  markKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateActiveKey,
} = await import('../../services/security/encryptionKeyRegistryService.js');

const {
  KEY_CLASSES, ENCRYPTION_KEY_ACTION_FENCE, ENCRYPTION_KEY_REFUSAL_CODES,
  TWIN_DISAGREEMENT_REASON,
  classifyForTenant, isRegistryManagedRow, tenantScopeState,
} = __testing__;

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000ff';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// --- fixtures: one row per class ---------------------------------------------

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAfakefakefakefake\n-----END PUBLIC KEY-----\n';

/** The only class this console owns. */
const REGISTRY_ROW = {
  id: 11,
  tenant_id: TENANT,
  key_id: 'k2026-q1',
  provider: 'env',
  algorithm: 'aes-256-gcm',
  status: 'active',
  rotated_from: null,
  metadata: {},
  wrapped_key_material: null,
  activated_at: '2026-01-01T00:00:00.000Z',
};

/** Stands in for wrapped key material: base64url(JSON {edek,wiv,wtag}). */
const FAKE_WRAPPED_MATERIAL = Buffer.from('{"edek":"fake"}').toString(
  'base64url',
);

/** tenantKekProvider.provisionTenantKek shape (tenantKekProvider.js:154-162). */
const LIVE_KEK_ROW = {
  id: 12,
  tenant_id: TENANT,
  key_id: `t:${TENANT}:v1`,
  provider: 'local-tenant',
  algorithm: 'aes-256-gcm',
  status: 'active',
  rotated_from: null,
  metadata: {},
  // Computed, not a literal: the base64url form of this fixture reads as a
  // bearer token to secret scanners even though it only encodes {"edek":"fake"}.
  wrapped_key_material: FAKE_WRAPPED_MATERIAL,
  activated_at: '2026-02-01T00:00:00.000Z',
};

/** clinicalContinuityGovernanceMigration.deep.test.js `seedKey()` shape. */
const POLICY_SIGNING_ROW = {
  id: 13,
  tenant_id: TENANT,
  key_id: 'cc-policy-2026',
  provider: 'env',
  algorithm: 'ed25519',
  status: 'active',
  rotated_from: null,
  metadata: {
    purpose: 'clinical_continuity_policy_signing',
    public_key_spki_pem: PUBLIC_KEY_PEM,
  },
  wrapped_key_material: null,
  activated_at: '2026-03-01T00:00:00.000Z',
};

/**
 * The pack signing key named by `clinical_continuity_policy_versions
 * .current_pack_signing_key_id` and `downtime_snapshots.signing_key_id`.
 * Deliberately the NEWEST active row, so an unfenced rotate would pick it as
 * the outgoing key and demote it to 'retiring' — which is exactly what
 * migration 600's publication trigger refuses to publish under.
 */
const PACK_SIGNING_ROW = {
  id: 14,
  tenant_id: TENANT,
  key_id: 'cc-pack-2026-q2',
  provider: 'env',
  algorithm: 'ed25519',
  status: 'active',
  rotated_from: null,
  metadata: {
    purpose: 'clinical_continuity_pack_signing',
    public_key_spki_pem: PUBLIC_KEY_PEM,
  },
  wrapped_key_material: null,
  activated_at: '2026-06-01T00:00:00.000Z',
};

/** Migration 630 compares the algorithm case-sensitively as 'Ed25519'. */
const INCIDENT_PACKET_SIGNING_ROW = {
  id: 15,
  tenant_id: TENANT,
  key_id: 'cc-incident-packet-2026',
  provider: 'env',
  algorithm: 'Ed25519',
  status: 'active',
  rotated_from: null,
  metadata: {
    purpose: 'clinical_continuity_incident_packet_signing',
    public_key_spki_pem: PUBLIC_KEY_PEM,
  },
  wrapped_key_material: null,
  activated_at: '2026-04-01T00:00:00.000Z',
};

/** scripts/seed-comprehensive-test-data.mjs writes signing keys this way. */
const SEEDED_SIGNING_ROW = {
  id: 16,
  tenant_id: TENANT,
  key_id: 'cc-pack-seed',
  provider: 'test_fixture',
  algorithm: 'ed25519',
  status: 'active',
  rotated_from: null,
  metadata: {
    seed: true,
    purpose: 'clinical_continuity_pack_signing',
    public_key_spki_pem: PUBLIC_KEY_PEM,
  },
  wrapped_key_material: null,
  activated_at: '2026-05-01T00:00:00.000Z',
};

/** A shape this console has never seen — an allowlist must refuse it. */
const UNKNOWN_PROVIDER_ROW = {
  id: 17,
  tenant_id: TENANT,
  key_id: 'ops-future-kms',
  provider: 'some-future-kms',
  algorithm: 'aes-256-gcm',
  status: 'active',
  rotated_from: null,
  metadata: {},
  wrapped_key_material: null,
  activated_at: '2026-01-15T00:00:00.000Z',
};

/**
 * Migration 129 leaves `encryption_keys.tenant_id` nullable, so a shared row is
 * a legal shape. It is inert by every marker the allowlist tests, and still
 * unmutable: every lifecycle statement is `WHERE ... tenant_id = $n::uuid` and
 * `NULL = <uuid>` is NULL, never TRUE. Deliberately the NEWEST active row, so a
 * predecessor search that dropped its tenant predicate would pick it and then
 * demote a row it can never reach — leaving the console reporting a rotation
 * that half happened.
 */
const UNTENANTED_ROW = {
  id: 18,
  tenant_id: null,
  key_id: 'legacy-shared-kek',
  provider: 'vault',
  algorithm: 'aes-256-gcm',
  status: 'active',
  rotated_from: null,
  metadata: {},
  wrapped_key_material: null,
  activated_at: '2026-06-15T00:00:00.000Z',
};

const ALL_ROWS = [
  REGISTRY_ROW,
  LIVE_KEK_ROW,
  POLICY_SIGNING_ROW,
  PACK_SIGNING_ROW,
  INCIDENT_PACKET_SIGNING_ROW,
  SEEDED_SIGNING_ROW,
  UNKNOWN_PROVIDER_ROW,
  UNTENANTED_ROW,
];

const KMS_PROVIDERS = ['env', 'aws-kms', 'gcp-kms', 'vault', 'azure-keyvault'];

/**
 * What makes a row inert registry metadata, stated independently of the service
 * (this is the SQL allowlist rewritten in JS from the migrations, not a call
 * into the code under test).
 */
function isInertRegistryRow(row) {
  const meta = row.metadata ?? {};
  const declared = (field) => meta[field] !== undefined && meta[field] !== null;
  return KMS_PROVIDERS.includes(row.provider)
    && row.wrapped_key_material === null
    && !(row.tenant_id !== null && new RegExp(`^t:${row.tenant_id}:v[0-9]+$`).test(row.key_id))
    && String(row.algorithm).toLowerCase() !== 'ed25519'
    && !declared('purpose')
    && !declared('public_key_spki_pem');
}

const FENCE_CLAUSES = [
  "provider IN ('env', 'aws-kms', 'gcp-kms', 'vault', 'azure-keyvault')",
  'wrapped_key_material IS NULL',
  "NOT (tenant_id IS NOT NULL AND key_id ~ ('^t:' || tenant_id::text || ':v[0-9]+$'))",
  "LOWER(algorithm) <> 'ed25519'",
  "metadata ->> 'purpose' IS NULL",
  "metadata ->> 'public_key_spki_pem' IS NULL",
];
const carriesFence = (sql) => FENCE_CLAUSES.every((clause) => sql.includes(clause));

/**
 * Apply a statement's OWN tenant predicate, the way Postgres would.
 *
 *  - `tenant_id = $n::uuid` never matches an untenanted row: `NULL = <uuid>` is
 *    NULL, not TRUE. That is the whole reason such a row is unmutable.
 *  - the listing/probe form `(tenant_id = $n::uuid OR tenant_id IS NULL)` also
 *    admits them, which is why they are visible at all.
 *  - a statement carrying NEITHER is left unfiltered — exactly what production
 *    would do, so a service that drops the predicate fails a test instead of
 *    being quietly forgiven by the fake.
 *
 * `tenant_id IS NOT NULL` inside the allowlist is not the wide form and must not
 * be read as one.
 */
function tenantReachable(sql, rows, tenant) {
  if (!/tenant_id = \$\d+::uuid/.test(sql)) return rows;
  const admitsUntenanted = /tenant_id IS NULL/.test(sql);
  return rows.filter((row) => (row.tenant_id !== null && row.tenant_id === tenant)
    || (admitsUntenanted && row.tenant_id === null));
}

const LIST_COLUMNS = [
  'id', 'tenant_id', 'key_id', 'provider', 'provider_reference', 'algorithm',
  'status', 'rotated_from', 'activated_at', 'retiring_at', 'retired_at',
  'metadata', 'created_by', 'created_at', 'updated_at',
];

/** Project a stored row the way the real SELECT list does — no material. */
function projectRow(row) {
  const out = {};
  for (const column of LIST_COLUMNS) out[column] = row[column] ?? null;
  return out;
}

/** The column list both existence probes select — never the material itself. */
function projectProbeRow(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    key_id: row.key_id,
    provider: row.provider,
    status: row.status,
    algorithm: row.algorithm,
    metadata: row.metadata,
    has_key_material: row.wrapped_key_material !== null,
  };
}

const newestFirst = (rows) => [...rows].sort((a, b) => b.activated_at.localeCompare(a.activated_at));

/**
 * Minimal encryption_keys stand-in. It answers every statement the service
 * emits, applies the allowlist ONLY where the statement carries it, and never
 * hands back `wrapped_key_material` for a column the real query does not
 * select. Returns the table so assertions can read row state back.
 */
function installFakeTable(rows = ALL_ROWS) {
  const table = rows.map((row) => ({ ...row }));
  let nextId = 100;
  queryUnsafeMock.mockImplementation(async (sql, ...params) => {
    // The listing: every visible row, each labelled by the allowlist.
    if (sql.includes('AS is_registry_managed')) {
      let out = tenantReachable(sql, table, params[0]);
      if (sql.includes('status = $2')) out = out.filter((row) => row.status === params[1]);
      return newestFirst(out).map((row) => ({
        ...projectRow(row),
        is_registry_managed: isInertRegistryRow(row),
        has_key_material: row.wrapped_key_material !== null,
      }));
    }

    // The retire/compromise refusal probe: one row BY ID ($1), tenant in $2.
    if (sql.includes('AS has_key_material') && /WHERE\s+id = \$1\b/.test(sql)) {
      return tenantReachable(sql, table, params[1])
        .filter((row) => row.id === params[0])
        .map(projectProbeRow);
    }

    // The rotation probe: every ACTIVE row this console can see, tenant in $1.
    // Deliberately unfenced — it exists to explain why the fenced predecessor
    // search found nothing, so it has to see the rows that search could not.
    if (sql.includes('AS has_key_material')) {
      const out = tenantReachable(sql, table, params[0])
        .filter((row) => row.status === 'active');
      return newestFirst(out).map(projectProbeRow);
    }

    const reachable = table.filter((row) => !carriesFence(sql) || isInertRegistryRow(row));

    // The rotate predecessor search.
    if (/^\s*SELECT/.test(sql)) {
      let out = tenantReachable(sql, reachable, params[0]);
      if (sql.includes("status = 'active'")) out = out.filter((row) => row.status === 'active');
      out = newestFirst(out).map((row) => ({ id: row.id, key_id: row.key_id }));
      return sql.includes('LIMIT 1') ? out.slice(0, 1) : out;
    }

    if (/^\s*INSERT/.test(sql)) {
      nextId += 1;
      // Only the rotate INSERT lists rotated_from as a column (the shared
      // RETURNING clause names it either way), and it binds it as $6.
      const isRotation = sql.includes('status, rotated_from, metadata');
      const row = {
        id: nextId,
        tenant_id: params[0],
        key_id: params[1],
        provider: params[2],
        provider_reference: params[3] ?? null,
        algorithm: params[4],
        status: 'active',
        rotated_from: isRotation ? params[5] : null,
        metadata: {},
        wrapped_key_material: null,
        activated_at: '2026-07-01T00:00:00.000Z',
      };
      table.push(row);
      return [projectRow(row)];
    }

    // UPDATE — compromise binds the reason as $1, so its id is $2. Every one of
    // the three (retire, compromise, the rotate demotion) binds its tenant in
    // the very next slot.
    const compromising = sql.includes("SET status = 'compromised'");
    const targetId = compromising ? params[1] : params[0];
    const tenantParam = compromising ? params[2] : params[1];
    const nextStatus = /SET status = '(\w+)'/.exec(sql)[1];
    let candidates = tenantReachable(sql, reachable, tenantParam)
      .filter((row) => row.id === targetId);
    if (sql.includes("status IN ('active', 'retiring')")) {
      candidates = candidates.filter((row) => ['active', 'retiring'].includes(row.status));
    }
    if (sql.includes("status <> 'compromised'")) {
      candidates = candidates.filter((row) => row.status !== 'compromised');
    }
    if (!candidates[0]) return [];
    candidates[0].status = nextStatus;
    return [projectRow(candidates[0])];
  });
  return table;
}

const rowById = (table, id) => table.find((row) => row.id === id);
const statusOf = (table, id) => rowById(table, id).status;

describe('registerEncryptionKey', () => {
  it('rejects missing key_id', async () => {
    await expect(registerEncryptionKey({ tenantId: TENANT })).rejects.toThrow(/key_id is required/);
  });
  it('rejects unknown provider', async () => {
    await expect(registerEncryptionKey({ tenantId: TENANT, keyId: 'k1', provider: 'magic' }))
      .rejects.toThrow(/provider must be one of/);
  });
  it('inserts an active key', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, key_id: 'k1', status: 'active' }]);
    const row = await registerEncryptionKey({ tenantId: TENANT, keyId: 'k1', provider: 'env' });
    expect(row.id).toBe(1);
  });
  it('throws conflict on duplicate key_id', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(registerEncryptionKey({ tenantId: TENANT, keyId: 'k1' }))
      .rejects.toThrow(/already registered/);
  });
});

describe('rotateActiveKey', () => {
  it('marks the previous active key as retiring and inserts the new one', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, key_id: 'k1' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, key_id: 'k2', status: 'active', rotated_from: 1 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2' });
    expect(row.id).toBe(2);
    expect(row.rotated_from).toBe(1);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/status = 'retiring'/);
  });

  it('inserts a first key only after confirming there is no active key at all', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // no allowlisted predecessor...
    queryUnsafeMock.mockResolvedValueOnce([]); // ...and no active key to explain it
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, key_id: 'k1', status: 'active', rotated_from: null }]);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k1' });
    expect(row.id).toBe(5);
    expect(row.rotated_from).toBeNull();
    // Three, not two: an empty predecessor search no longer licenses an insert
    // on its own — the probe between them is what separates "this tenant has no
    // keys" from "this tenant's active keys are all withheld".
    expect(queryUnsafeMock.mock.calls).toHaveLength(3);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/AS has_key_material/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/^\s*INSERT/);
  });
});

describe('retireEncryptionKey', () => {
  it('throws 404 when not found or already retired', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // guarded UPDATE matched nothing
    queryUnsafeMock.mockResolvedValueOnce([]); // ...and there is no row to explain
    await expect(retireEncryptionKey({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('flips status to retired', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'retired' }]);
    const row = await retireEncryptionKey({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('retired');
  });
});

describe('markKeyCompromised', () => {
  it('flips status to compromised + records reason in metadata', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'compromised' }]);
    const row = await markKeyCompromised({ tenantId: TENANT, id: 1, reason: 'Vault leak 2026-04-29' });
    expect(row.status).toBe('compromised');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/jsonb_build_object/);
  });
});

// --- the allowlist ------------------------------------------------------------

describe('classifyEncryptionKeyRow is an allowlist, not a denylist', () => {
  it.each([
    ['registry metadata', REGISTRY_ROW, true, KEY_CLASSES.REGISTRY],
    ['live per-tenant KEK', LIVE_KEK_ROW, false, KEY_CLASSES.LIVE_MATERIAL],
    ['continuity policy signing key', POLICY_SIGNING_ROW, false, KEY_CLASSES.SIGNING],
    ['continuity pack signing key', PACK_SIGNING_ROW, false, KEY_CLASSES.SIGNING],
    ['incident-packet signing key', INCIDENT_PACKET_SIGNING_ROW, false, KEY_CLASSES.SIGNING],
    ['seeded signing key (non-KMS provider)', SEEDED_SIGNING_ROW, false, KEY_CLASSES.SIGNING],
    ['unrecognised provider', UNKNOWN_PROVIDER_ROW, false, KEY_CLASSES.UNPROVEN],
  ])('classifies %s', (_label, row, mutable, keyClass) => {
    const verdict = classifyEncryptionKeyRow(row);
    expect(verdict.mutable).toBe(mutable);
    expect(verdict.keyClass).toBe(keyClass);
    // The JS twin and the independently-stated SQL allowlist must agree.
    expect(verdict.mutable).toBe(isInertRegistryRow(row));
  });

  it('names the marker that fenced the row', () => {
    expect(classifyEncryptionKeyRow(LIVE_KEK_ROW).reason).toMatch(/local-tenant/);
    expect(classifyEncryptionKeyRow(PACK_SIGNING_ROW).reason)
      .toMatch(/clinical_continuity_pack_signing/);
    expect(classifyEncryptionKeyRow(UNKNOWN_PROVIDER_ROW).reason)
      .toMatch(/some-future-kms/);
  });

  it('fails CLOSED on a row selected with the real wrapped_key_material column', () => {
    // The fail-OPEN twin this replaces read only `has_key_material`, so a row
    // carrying the actual column scored `undefined !== true` and looked mutable.
    const verdict = classifyEncryptionKeyRow({
      id: 99,
      tenant_id: TENANT,
      key_id: 'looks-inert',
      provider: 'env',
      algorithm: 'aes-256-gcm',
      metadata: {},
      wrapped_key_material: FAKE_WRAPPED_MATERIAL,
    });
    expect(verdict.mutable).toBe(false);
    expect(verdict.keyClass).toBe(KEY_CLASSES.LIVE_MATERIAL);
  });

  it('fails CLOSED when the row says nothing about key material at all', () => {
    const verdict = classifyEncryptionKeyRow({
      id: 99, tenant_id: TENANT, key_id: 'partial', provider: 'env',
      algorithm: 'aes-256-gcm', metadata: {},
    });
    expect(verdict.mutable).toBe(false);
    expect(verdict.keyClass).toBe(KEY_CLASSES.UNPROVEN);
    expect(verdict.reason).toMatch(/whether it holds key material/);
  });

  it('fails CLOSED on an unreadable row', () => {
    expect(classifyEncryptionKeyRow(null).mutable).toBe(false);
    expect(classifyEncryptionKeyRow(undefined).keyClass).toBe(KEY_CLASSES.UNPROVEN);
  });

  it('fails CLOSED on an undeclared metadata.purpose it cannot vouch for', () => {
    const verdict = classifyEncryptionKeyRow({
      ...REGISTRY_ROW, metadata: { purpose: 'some_future_subsystem_signing' },
    });
    expect(verdict.mutable).toBe(false);
    expect(verdict.keyClass).toBe(KEY_CLASSES.UNPROVEN);
  });

  it('reads an empty wrapped_key_material as material, exactly like IS NULL', () => {
    // `wrapped_key_material` is `text` (migration 337). '' is NOT NULL, so the
    // SQL twin scores such a row not-inert; reading it as "no material" here
    // would put the two fences on opposite sides of one row.
    const row = { ...REGISTRY_ROW, wrapped_key_material: '' };
    expect(isInertRegistryRow(row)).toBe(false);
    expect(classifyEncryptionKeyRow(row).mutable).toBe(false);
    expect(classifyEncryptionKeyRow(row).keyClass).toBe(KEY_CLASSES.LIVE_MATERIAL);
  });
});

describe('isRegistryManagedRow', () => {
  it('agrees with the classifier on every fixture', () => {
    for (const row of ALL_ROWS) {
      expect(isRegistryManagedRow(row)).toBe(classifyEncryptionKeyRow(row).mutable);
    }
  });

  it.each([
    ['a row carrying the real wrapped_key_material column', {
      ...REGISTRY_ROW, wrapped_key_material: FAKE_WRAPPED_MATERIAL,
    }],
    ['a row selected without any material column', {
      id: 99, tenant_id: TENANT, key_id: 'partial', provider: 'env',
      algorithm: 'aes-256-gcm', metadata: {},
    }],
    ['a row that says nothing at all', {}],
  ])('fails CLOSED for %s', (_label, row) => {
    // The round-1 twin keyed on `row.has_key_material` alone, so a row selected
    // with the real column name scored `undefined !== true` and read as
    // mutable — a fail-OPEN predicate wearing a fail-closed name.
    expect(isRegistryManagedRow(row)).toBe(false);
  });

  it('is true only for a row on which every marker is positively observed', () => {
    expect(isRegistryManagedRow(REGISTRY_ROW)).toBe(true);
    expect(isRegistryManagedRow({ ...REGISTRY_ROW, has_key_material: false })).toBe(true);
  });

  it('answers inertness only — an untenanted row is inert and still unmutable', () => {
    expect(isRegistryManagedRow(UNTENANTED_ROW)).toBe(true);
    expect(classifyForTenant(UNTENANTED_ROW, TENANT).mutable).toBe(false);
  });
});

describe('tenant scope is a second, independent gate', () => {
  it.each([
    ['this tenant\'s row', REGISTRY_ROW, 'owned'],
    ['an untenanted row', UNTENANTED_ROW, 'unscoped'],
    ['another tenant\'s row', { ...REGISTRY_ROW, tenant_id: OTHER_TENANT }, 'foreign'],
    ['a row read without tenant_id', { key_id: 'k', provider: 'env' }, 'unknown'],
  ])('places %s', (_label, row, state) => {
    expect(tenantScopeState(row, TENANT)).toBe(state);
  });

  it('lets the more informative live-key refusal win over the scope one', () => {
    // An untenanted per-tenant KEK is unmutable twice over. The operator needs
    // to hear "this is live envelope key material", not "wrong tenant".
    const verdict = classifyForTenant({ ...LIVE_KEK_ROW, tenant_id: null }, TENANT);
    expect(verdict.keyClass).toBe(KEY_CLASSES.LIVE_MATERIAL);
  });

  it.each([
    ['an untenanted row', null],
    ['another tenant\'s row', OTHER_TENANT],
  ])('refuses %s that is otherwise perfectly inert', (_label, tenant) => {
    const verdict = classifyForTenant({ ...REGISTRY_ROW, tenant_id: tenant }, TENANT);
    expect(verdict.mutable).toBe(false);
    expect(verdict.keyClass).toBe(KEY_CLASSES.OUT_OF_TENANT_SCOPE);
    expect(verdict.reason).toEqual(expect.any(String));
  });
});

describe('every live-key class is unreachable from the console', () => {
  it('lists only the registry row, and reports every withheld row by class', async () => {
    installFakeTable();
    const result = await listEncryptionKeys({ tenantId: TENANT });

    expect(result.keys.map((row) => row.key_id)).toEqual([REGISTRY_ROW.key_id]);
    expect(result.count).toBe(1);
    expect(result.protected_count).toBe(ALL_ROWS.length - 1);
    expect(new Map(result.protected.map((row) => [row.key_id, row.key_class]))).toEqual(
      new Map([
        [LIVE_KEK_ROW.key_id, KEY_CLASSES.LIVE_MATERIAL],
        [POLICY_SIGNING_ROW.key_id, KEY_CLASSES.SIGNING],
        [PACK_SIGNING_ROW.key_id, KEY_CLASSES.SIGNING],
        [INCIDENT_PACKET_SIGNING_ROW.key_id, KEY_CLASSES.SIGNING],
        [SEEDED_SIGNING_ROW.key_id, KEY_CLASSES.SIGNING],
        [UNKNOWN_PROVIDER_ROW.key_id, KEY_CLASSES.UNPROVEN],
        [UNTENANTED_ROW.key_id, KEY_CLASSES.OUT_OF_TENANT_SCOPE],
      ]),
    );
    // Withheld, never silent: every entry says why.
    for (const row of result.protected) expect(row.reason).toEqual(expect.any(String));
  });

  it('never returns key material or its existence probe to the caller', async () => {
    installFakeTable();
    const { keys, protected: withheld } = await listEncryptionKeys({ tenantId: TENANT });
    for (const row of [...keys, ...withheld]) {
      expect(row).not.toHaveProperty('wrapped_key_material');
      expect(row).not.toHaveProperty('has_key_material');
      expect(row).not.toHaveProperty('is_registry_managed');
    }
  });

  it('keeps the partition when a status filter is applied', async () => {
    installFakeTable();
    const result = await listEncryptionKeys({ tenantId: TENANT, status: 'active' });
    expect(result.keys.map((row) => row.key_id)).toEqual([REGISTRY_ROW.key_id]);
    expect(result.protected_count).toBe(ALL_ROWS.length - 1);
  });

  it('rotate links to the registry predecessor and leaves every live key active', async () => {
    const table = installFakeTable();
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' });

    // Pre-fix the newest active row was the pack signing key, so it became the
    // predecessor and was demoted to 'retiring' — after which migration 600's
    // publication trigger (600:1322-1334) refuses every continuity pack.
    expect(row.rotated_from).toBe(REGISTRY_ROW.id);
    expect(statusOf(table, REGISTRY_ROW.id)).toBe('retiring');
    for (const fixture of ALL_ROWS.filter((r) => r.id !== REGISTRY_ROW.id)) {
      expect(statusOf(table, fixture.id)).toBe('active');
    }
  });

  it.each([
    ['live per-tenant KEK', LIVE_KEK_ROW, 'ENCRYPTION_KEY_LIVE_MATERIAL', KEY_CLASSES.LIVE_MATERIAL],
    ['continuity policy signing key', POLICY_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL', KEY_CLASSES.SIGNING],
    ['continuity pack signing key', PACK_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL', KEY_CLASSES.SIGNING],
    ['incident-packet signing key', INCIDENT_PACKET_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL', KEY_CLASSES.SIGNING],
    ['seeded signing key', SEEDED_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL', KEY_CLASSES.SIGNING],
    ['unrecognised provider', UNKNOWN_PROVIDER_ROW, 'ENCRYPTION_KEY_NOT_PROVABLY_INERT', KEY_CLASSES.UNPROVEN],
    ['untenanted shared row', UNTENANTED_ROW, 'ENCRYPTION_KEY_NOT_TENANT_SCOPED', KEY_CLASSES.OUT_OF_TENANT_SCOPE],
  ])('refuses to retire a %s, explicitly', async (_label, fixture, code, keyClass) => {
    const table = installFakeTable();
    await expect(retireEncryptionKey({ tenantId: TENANT, id: fixture.id })).rejects.toMatchObject({
      statusCode: 409,
      code,
      details: { id: fixture.id, key_id: fixture.key_id, key_class: keyClass },
    });
    expect(statusOf(table, fixture.id)).toBe('active');
  });

  it.each([
    ['live per-tenant KEK', LIVE_KEK_ROW, 'ENCRYPTION_KEY_LIVE_MATERIAL'],
    ['continuity policy signing key', POLICY_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL'],
    ['continuity pack signing key', PACK_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL'],
    ['incident-packet signing key', INCIDENT_PACKET_SIGNING_ROW, 'ENCRYPTION_KEY_SIGNING_MATERIAL'],
    ['unrecognised provider', UNKNOWN_PROVIDER_ROW, 'ENCRYPTION_KEY_NOT_PROVABLY_INERT'],
    ['untenanted shared row', UNTENANTED_ROW, 'ENCRYPTION_KEY_NOT_TENANT_SCOPED'],
  ])('refuses to mark a %s compromised, explicitly', async (_label, fixture, code) => {
    const table = installFakeTable();
    await expect(markKeyCompromised({ tenantId: TENANT, id: fixture.id, reason: 'panic' }))
      .rejects.toMatchObject({ statusCode: 409, code });
    expect(statusOf(table, fixture.id)).toBe('active');
  });

  it('explains a signing-key refusal in terms an operator can act on', async () => {
    installFakeTable();
    await expect(retireEncryptionKey({ tenantId: TENANT, id: PACK_SIGNING_ROW.id }))
      .rejects.toThrow(/migration 600.*migration 630.*revoked_key_ids/s);
  });

  it('still retires and compromises genuine registry rows', async () => {
    const table = installFakeTable();
    const retired = await retireEncryptionKey({ tenantId: TENANT, id: REGISTRY_ROW.id });
    expect(retired.status).toBe('retired');

    const compromised = await markKeyCompromised({
      tenantId: TENANT, id: REGISTRY_ROW.id, reason: 'Vault leak 2026-04-29',
    });
    expect(compromised.status).toBe('compromised');
    for (const fixture of ALL_ROWS.filter((r) => r.id !== REGISTRY_ROW.id)) {
      expect(statusOf(table, fixture.id)).toBe('active');
    }
  });

  it('refuses an already crypto-shredded tenant row (provider marker alone)', async () => {
    // cryptoShredTenant leaves status 'compromised' with the material cleared;
    // the row is still a burnt tenant key id that must never be reissued.
    installFakeTable([{
      ...LIVE_KEK_ROW, status: 'compromised', wrapped_key_material: null,
    }]);
    await expect(retireEncryptionKey({ tenantId: TENANT, id: LIVE_KEK_ROW.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ENCRYPTION_KEY_LIVE_MATERIAL' });
  });

  it('refuses any material-bearing row, whatever provider it claims', async () => {
    installFakeTable([{ ...REGISTRY_ROW, wrapped_key_material: FAKE_WRAPPED_MATERIAL }]);
    const { keys, protected_count: withheld } = await listEncryptionKeys({ tenantId: TENANT });
    expect(keys).toEqual([]);
    expect(withheld).toBe(1);
    await expect(retireEncryptionKey({ tenantId: TENANT, id: REGISTRY_ROW.id }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ENCRYPTION_KEY_LIVE_MATERIAL' });
  });

  it('still 404s a registry row that is already retired', async () => {
    installFakeTable([{ ...REGISTRY_ROW, status: 'retired' }]);
    await expect(retireEncryptionKey({ tenantId: TENANT, id: REGISTRY_ROW.id }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('never reads the wrapped material into the console', async () => {
    installFakeTable();
    await listEncryptionKeys({ tenantId: TENANT });
    await expect(retireEncryptionKey({ tenantId: TENANT, id: LIVE_KEK_ROW.id })).rejects.toThrow();
    // Including the rotation probe, which is the third statement to name the
    // column and must test it for existence like the other two.
    installFakeTable([LIVE_KEK_ROW]);
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' })).rejects.toThrow();
    const statements = queryUnsafeMock.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes('wrapped_key_material'))).toBe(true);
    for (const sql of statements) {
      // Every mention is an existence test — the material itself never crosses
      // into the console process.
      for (const mention of sql.match(/wrapped_key_material[^\n,)]*/g) ?? []) {
        expect(mention).toMatch(/^wrapped_key_material IS (NOT )?NULL$/);
      }
    }
  });

  it('every statement that mutates a row is tenant-scoped on its own face', async () => {
    const table = installFakeTable();
    await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q4' });
    await retireEncryptionKey({ tenantId: TENANT, id: REGISTRY_ROW.id });
    await markKeyCompromised({ tenantId: TENANT, id: REGISTRY_ROW.id, reason: 'x' });
    expect(statusOf(table, REGISTRY_ROW.id)).toBe('compromised');

    const updates = queryUnsafeMock.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^\s*UPDATE/.test(sql));
    // Three: the rotate demotion, the retire, the compromise. The demotion is
    // the one that used to key on `id` alone and lean on where that id came
    // from — a rotation would then demote a row its own predecessor search was
    // no longer allowed to see.
    expect(updates).toHaveLength(3);
    for (const sql of updates) expect(sql).toMatch(/tenant_id = \$\d+::uuid/);
  });
});

describe('an untenanted row is visible but unreachable, and says so', () => {
  it('is withheld from the actionable list with its own class and reason', async () => {
    installFakeTable([REGISTRY_ROW, UNTENANTED_ROW]);
    const { keys, protected: withheld } = await listEncryptionKeys({ tenantId: TENANT });

    expect(keys.map((row) => row.key_id)).toEqual([REGISTRY_ROW.key_id]);
    expect(withheld).toEqual([expect.objectContaining({
      id: UNTENANTED_ROW.id,
      tenant_id: null,
      key_id: UNTENANTED_ROW.key_id,
      key_class: KEY_CLASSES.OUT_OF_TENANT_SCOPE,
      reason: expect.stringContaining('tenant_id'),
    })]);
  });

  it('refuses retirement by name instead of 404ing an active row as retired', async () => {
    const table = installFakeTable([REGISTRY_ROW, UNTENANTED_ROW]);
    // Pre-fix this row was listed as actionable and then answered
    // "not found or already retired" — a bare 404 on a row that is neither.
    await expect(retireEncryptionKey({ tenantId: TENANT, id: UNTENANTED_ROW.id }))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'ENCRYPTION_KEY_NOT_TENANT_SCOPED',
        details: { id: UNTENANTED_ROW.id, key_class: KEY_CLASSES.OUT_OF_TENANT_SCOPE },
      });
    expect(statusOf(table, UNTENANTED_ROW.id)).toBe('active');
  });

  it('is never picked as a rotation predecessor, though it is the newest active row', async () => {
    const table = installFakeTable([REGISTRY_ROW, UNTENANTED_ROW]);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' });
    expect(row.rotated_from).toBe(REGISTRY_ROW.id);
    expect(statusOf(table, UNTENANTED_ROW.id)).toBe('active');
    expect(statusOf(table, REGISTRY_ROW.id)).toBe('retiring');
  });

  it('withholds a row the two fences disagree about, as UNPROVEN', async () => {
    // jsonb `metadata` need not be an object: for an array, `->> 'purpose'` is
    // NULL, so the SQL allowlist admits it while the JS twin cannot read it.
    // Drift between the twins may only ever resolve toward "not provably inert".
    const drifted = { ...REGISTRY_ROW, id: 31, key_id: 'array-metadata', metadata: [1, 2] };
    installFakeTable([drifted]);
    const { keys, protected: withheld } = await listEncryptionKeys({ tenantId: TENANT });
    expect(keys).toEqual([]);
    expect(withheld).toEqual([expect.objectContaining({
      id: drifted.id,
      key_class: KEY_CLASSES.UNPROVEN,
      reason: 'the SQL allowlist and its JS twin disagree about this row',
    })]);
  });
});

describe('the reserved KEK key-id namespace is anchored to one tenant', () => {
  it('refuses to mint an id inside THIS tenant\'s namespace', async () => {
    installFakeTable();
    await expect(registerEncryptionKey({ tenantId: TENANT, keyId: `t:${TENANT}:v2` }))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENCRYPTION_KEY_ID_RESERVED' });
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: `t:${TENANT}:v2` }))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENCRYPTION_KEY_ID_RESERVED' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('accepts a lookalike id no KEK lifecycle can produce', async () => {
    // tenantKekProvider only ever writes `t:<tenant uuid>:v<n>` for the row's
    // OWN tenant (tenantKekProvider.js:111/228/250), so `t:acme:v2` is an
    // ordinary operator id — the round-1 `^t:.+:v\d+$` made it unregistrable.
    installFakeTable([]);
    const row = await registerEncryptionKey({ tenantId: TENANT, keyId: 't:acme:v2' });
    expect(row.key_id).toBe('t:acme:v2');
  });

  it('keeps a lookalike id listable and mutable', async () => {
    const lookalike = { ...REGISTRY_ROW, id: 21, key_id: 't:acme:v2' };
    const otherTenantsShape = { ...REGISTRY_ROW, id: 22, key_id: `t:${OTHER_TENANT}:v1` };
    const table = installFakeTable([lookalike, otherTenantsShape]);

    const { keys } = await listEncryptionKeys({ tenantId: TENANT });
    expect(keys.map((row) => row.key_id).sort())
      .toEqual(['t:acme:v2', `t:${OTHER_TENANT}:v1`].sort());

    await retireEncryptionKey({ tenantId: TENANT, id: lookalike.id });
    expect(statusOf(table, lookalike.id)).toBe('retired');
  });

  it('still fences the real KEK id for the tenant that owns it', () => {
    expect(classifyEncryptionKeyRow({
      ...REGISTRY_ROW, key_id: `t:${TENANT}:v9`,
    }).keyClass).toBe(KEY_CLASSES.LIVE_MATERIAL);
  });
});

// --- (1) the refusal is total, not partial -----------------------------------

const PROTECTED_FIXTURES = ALL_ROWS.filter((row) => row.id !== REGISTRY_ROW.id);

describe('rotation refuses when the key it would displace is withheld', () => {
  it.each([
    ['a live per-tenant KEK', [LIVE_KEK_ROW], LIVE_KEK_ROW, KEY_CLASSES.LIVE_MATERIAL],
    ['a continuity pack signing key', [PACK_SIGNING_ROW], PACK_SIGNING_ROW, KEY_CLASSES.SIGNING],
    ['an unrecognised provider', [UNKNOWN_PROVIDER_ROW], UNKNOWN_PROVIDER_ROW, KEY_CLASSES.UNPROVEN],
    ['an untenanted shared row', [UNTENANTED_ROW], UNTENANTED_ROW, KEY_CLASSES.OUT_OF_TENANT_SCOPE],
    ['every withheld class at once', PROTECTED_FIXTURES, UNTENANTED_ROW, KEY_CLASSES.OUT_OF_TENANT_SCOPE],
  ])('refuses a tenant whose active keys are %s', async (_label, rows, blocking, keyClass) => {
    // Round 2 narrowed the predecessor search to the allowlist and stopped
    // there: the search found nothing, rotation read that as "no keys yet" and
    // inserted an unlinked row, so the withheld key stayed active beside a new
    // one that claimed to have replaced it — while the console said the action
    // was refused. The intent is unsatisfiable here, so now it is refused.
    const table = installFakeTable(rows);
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ENCRYPTION_KEY_ROTATION_PREDECESSOR_PROTECTED',
      details: {
        id: blocking.id,
        key_id: blocking.key_id,
        key_class: keyClass,
        new_key_id: 'k2026-q3',
        withheld_active_count: rows.length,
      },
    });
    expect(table.map((row) => row.key_id)).not.toContain('k2026-q3');
    for (const row of rows) expect(statusOf(table, row.id)).toBe('active');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /^\s*INSERT/.test(sql))).toBe(false);
  });

  it('probes exactly the rows the listing shows, and unfenced', async () => {
    installFakeTable([LIVE_KEK_ROW]);
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' })).rejects.toThrow();
    const [search, probe] = queryUnsafeMock.mock.calls.map(([sql]) => sql);
    // The search that PICKS a predecessor is fenced and narrow; the probe that
    // EXPLAINS an empty search must see the rows the fence hid from it, or it
    // would answer "no active keys" for the very case it exists to catch.
    expect(carriesFence(search)).toBe(true);
    expect(search).toMatch(/tenant_id = \$1::uuid/);
    expect(carriesFence(probe)).toBe(false);
    expect(probe).toMatch(/\(tenant_id = \$1::uuid OR tenant_id IS NULL\)/);
    expect(probe).toMatch(/status = 'active'/);
  });

  it('names the blocking key and the lifecycle that does own it', async () => {
    installFakeTable([LIVE_KEK_ROW]);
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' }))
      .rejects.toThrow(/rotation in name only.*tenantKekProvider\.js/s);
  });

  it('still rotates when one allowlisted active key sits among withheld ones', async () => {
    const table = installFakeTable(ALL_ROWS);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' });
    expect(row.rotated_from).toBe(REGISTRY_ROW.id);
    expect(statusOf(table, REGISTRY_ROW.id)).toBe('retiring');
  });

  it('inserts an unlinked first key when nothing is ACTIVE, retired rows included', async () => {
    const table = installFakeTable([
      { ...REGISTRY_ROW, status: 'retired' },
      { ...PACK_SIGNING_ROW, status: 'retired' },
    ]);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' });
    expect(row.rotated_from).toBeNull();
    expect(table.map((r) => r.key_id)).toContain('k2026-q3');
  });

  it('makes rotated_from null mean "no active key", never "predecessor withheld"', async () => {
    installFakeTable([REGISTRY_ROW, PACK_SIGNING_ROW]);
    expect((await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-linked' })).rotated_from)
      .toBe(REGISTRY_ROW.id);

    installFakeTable([]);
    expect((await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-bootstrap' })).rotated_from)
      .toBeNull();

    installFakeTable([PACK_SIGNING_ROW]);
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-refused' })).rejects.toMatchObject({
      code: ENCRYPTION_KEY_REFUSAL_CODES.ROTATION_PREDECESSOR_PROTECTED,
    });
  });

  it('fails closed if the probe finds a row the fenced search should have picked', async () => {
    // Both fences are built from the same markers, so a row that is mutable to
    // the JS twin and invisible to the fenced SQL search should not exist; this
    // is the guard for the day one of them drifts. It must not read "JS says
    // mutable" as licence to insert, and it resolves drift the way the listing
    // does: not provably inert. Driven with explicit results rather than the
    // fake table precisely because the fake — like Postgres — cannot produce
    // this disagreement.
    queryUnsafeMock.mockResolvedValueOnce([]); // fenced predecessor search: nothing
    queryUnsafeMock.mockResolvedValueOnce([{ // probe: an inert, tenant-owned, active row
      id: 77,
      tenant_id: TENANT,
      key_id: 'drifted',
      provider: 'env',
      status: 'active',
      algorithm: 'aes-256-gcm',
      metadata: {},
      has_key_material: false,
    }]);
    await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2026-q3' })).rejects.toMatchObject({
      statusCode: 409,
      code: ENCRYPTION_KEY_REFUSAL_CODES.ROTATION_PREDECESSOR_PROTECTED,
      details: { id: 77, key_class: KEY_CLASSES.UNPROVEN, reason: TWIN_DISAGREEMENT_REASON },
    });
    expect(queryUnsafeMock.mock.calls).toHaveLength(2); // refused before the INSERT
  });
});

// --- (2) anything this module can create, this module can manage --------------

describe('anything this module can create, this module can manage', () => {
  /**
   * "Manage" is the operative word: a row is manageable here when it comes back
   * in `keys`, where the console can act on it. `REGISTRY_MANAGED_SQL` excludes
   * rows by algorithm and by metadata, and `register` took both as free text —
   * so typing 'Ed25519' minted a row that succeeded, vanished from the list on
   * the very next read, and (where both fences agree) could never be retired or
   * marked compromised. A trap this fix's own fence introduced.
   */
  const UNMANAGEABLE = [
    {
      label: 'an Ed25519 algorithm',
      input: { algorithm: 'Ed25519' },
      stored: { algorithm: 'Ed25519' },
      mintClass: KEY_CLASSES.SIGNING,
      refusedByName: true,
    },
    {
      label: 'a lower-case ed25519 algorithm',
      input: { algorithm: 'ed25519' },
      stored: { algorithm: 'ed25519' },
      mintClass: KEY_CLASSES.SIGNING,
      refusedByName: true,
    },
    {
      label: 'a continuity pack-signing purpose',
      input: { metadata: { purpose: 'clinical_continuity_pack_signing' } },
      stored: { metadata: { purpose: 'clinical_continuity_pack_signing' } },
      mintClass: KEY_CLASSES.SIGNING,
      refusedByName: true,
    },
    {
      label: 'a published SPKI public key',
      input: { metadata: { public_key_spki_pem: PUBLIC_KEY_PEM } },
      stored: { metadata: { public_key_spki_pem: PUBLIC_KEY_PEM } },
      mintClass: KEY_CLASSES.SIGNING,
      refusedByName: true,
    },
    {
      label: 'a purpose this console cannot vouch for',
      input: { metadata: { purpose: 'some_future_subsystem_signing' } },
      stored: { metadata: { purpose: 'some_future_subsystem_signing' } },
      mintClass: KEY_CLASSES.UNPROVEN,
      refusedByName: true,
    },
    {
      // The two fences disagree about this one, so it is withheld as UNPROVEN
      // and the console can never offer it — but the guarded UPDATEs are gated
      // by the SQL side alone, which admits it. Unlistable, not unretirable:
      // the assertions below only claim the part that is true.
      label: 'metadata that is not an object',
      input: { metadata: [1, 2] },
      stored: { metadata: [1, 2] },
      mintClass: KEY_CLASSES.UNPROVEN,
      refusedByName: false,
    },
  ];

  it.each(UNMANAGEABLE.map((testCase) => [testCase.label, testCase]))(
    'a row with %s never reaches `keys`, so neither INSERT path may mint one',
    async (_label, testCase) => {
      // 1. What this console does with such a row when it already exists.
      const planted = { ...REGISTRY_ROW, id: 41, key_id: 'planted', ...testCase.stored };
      const table = installFakeTable([planted]);
      const listed = await listEncryptionKeys({ tenantId: TENANT });
      expect(listed.keys).toEqual([]);
      expect(listed.protected_count).toBe(1);
      if (testCase.refusedByName) {
        await expect(retireEncryptionKey({ tenantId: TENANT, id: planted.id }))
          .rejects.toMatchObject({ statusCode: 409 });
        await expect(markKeyCompromised({ tenantId: TENANT, id: planted.id, reason: 'x' }))
          .rejects.toMatchObject({ statusCode: 409 });
        expect(statusOf(table, planted.id)).toBe('active');
      }

      // 2. So it is refused up front — before any statement is issued.
      queryUnsafeMock.mockClear();
      await expect(registerEncryptionKey({ tenantId: TENANT, keyId: 'mint-me', ...testCase.input }))
        .rejects.toMatchObject({
          statusCode: 400,
          code: 'ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE',
          details: { key_id: 'mint-me', key_class: testCase.mintClass, reason: expect.any(String) },
        });
      await expect(rotateActiveKey({ tenantId: TENANT, newKeyId: 'mint-me', ...testCase.input }))
        .rejects.toMatchObject({
          statusCode: 400,
          code: 'ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE',
          details: { key_id: 'mint-me', key_class: testCase.mintClass },
        });
      expect(queryUnsafeMock).not.toHaveBeenCalled();
    },
  );

  const MINTERS = [
    ['register', (args) => registerEncryptionKey({ tenantId: TENANT, keyId: 'k-mint', ...args })],
    ['rotate', (args) => rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-mint', ...args })],
  ];

  it.each(MINTERS)('%s refuses a blank algorithm instead of binding NULL', async (_label, call) => {
    // `encryption_keys.algorithm` is NOT NULL (migration 129:32) and `safeText`
    // turns whitespace into null, so this used to reach Postgres as a not-null
    // violation and surface as a 500.
    installFakeTable();
    await expect(call({ algorithm: '   ' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE',
      details: { algorithm: null, key_class: KEY_CLASSES.UNPROVEN },
    });
  });

  it.each(MINTERS)('%s refuses metadata that cannot be stored as jsonb', async (_label, call) => {
    installFakeTable();
    const circular = {};
    circular.self = circular;
    await expect(call({ metadata: circular })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ENCRYPTION_KEY_METADATA_UNSTORABLE',
    });
  });

  it.each(MINTERS)('%s still mints an ordinary KEK metadata row', async (_label, call) => {
    const table = installFakeTable([]);
    const row = await call({ algorithm: 'aes-256-gcm', metadata: { note: 'q3 rollover' } });
    expect(row.key_id).toBe('k-mint');
    // And what it minted is in the actionable half of the very next read.
    const { keys } = await listEncryptionKeys({ tenantId: TENANT });
    expect(keys.map((key) => key.key_id)).toContain('k-mint');
    expect(rowById(table, row.id).status).toBe('active');
  });
});

// --- disclosure: nothing is dropped, and the field names are the contract ----

describe('the listing discloses withheld rows under stable field names', () => {
  const PROTECTED_FIELDS = ['id', 'key_class', 'key_id', 'provider', 'reason', 'status', 'tenant_id'];

  it('returns keys/count/protected/protected_count and nothing else', async () => {
    installFakeTable();
    const result = await listEncryptionKeys({ tenantId: TENANT });
    expect(Object.keys(result).sort()).toEqual(['count', 'keys', 'protected', 'protected_count']);
    expect(result.count).toBe(result.keys.length);
    expect(result.protected_count).toBe(result.protected.length);
    // Every visible row lands in exactly one bucket — withheld is not dropped.
    expect(result.count + result.protected_count).toBe(ALL_ROWS.length);
  });

  it('gives every withheld row the same field set, class and reason', async () => {
    installFakeTable();
    const { protected: withheld } = await listEncryptionKeys({ tenantId: TENANT });
    expect(withheld).toHaveLength(PROTECTED_FIXTURES.length);
    for (const row of withheld) {
      expect(Object.keys(row).sort()).toEqual(PROTECTED_FIELDS);
      expect(typeof row.reason).toBe('string');
      expect(Object.values(KEY_CLASSES)).toContain(row.key_class);
      expect(row.key_class).not.toBe(KEY_CLASSES.REGISTRY);
    }
  });

  it('gives every actionable row the registry column set', async () => {
    installFakeTable();
    const { keys } = await listEncryptionKeys({ tenantId: TENANT });
    expect(keys).toHaveLength(1);
    for (const row of keys) expect(Object.keys(row).sort()).toEqual([...LIST_COLUMNS].sort());
  });

  it('reports twin drift under the one reason string both paths share', async () => {
    installFakeTable([{ ...REGISTRY_ROW, metadata: [1, 2] }]);
    const { protected: withheld } = await listEncryptionKeys({ tenantId: TENANT });
    expect(withheld[0].reason).toBe(TWIN_DISAGREEMENT_REASON);
  });
});

// --- the per-action contract the console renders ------------------------------

describe('the declared per-action fence is what the code actually does', () => {
  const circular = () => {
    const value = {};
    value.self = value;
    return value;
  };

  const REFUSAL_SCENARIOS = {
    list: [],
    register: [
      () => registerEncryptionKey({ tenantId: TENANT, keyId: `t:${TENANT}:v2` }),
      () => registerEncryptionKey({ tenantId: TENANT, keyId: 'k-new', algorithm: 'Ed25519' }),
      () => registerEncryptionKey({ tenantId: TENANT, keyId: 'k-new', metadata: circular() }),
    ],
    rotate: [
      () => rotateActiveKey({ tenantId: TENANT, newKeyId: `t:${TENANT}:v2` }),
      () => rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-new', algorithm: 'Ed25519' }),
      () => rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-new', metadata: circular() }),
      () => rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-new' }),
    ],
    retire: PROTECTED_FIXTURES.map((row) => () => retireEncryptionKey({ tenantId: TENANT, id: row.id })),
    compromise: PROTECTED_FIXTURES.map(
      (row) => () => markKeyCompromised({ tenantId: TENANT, id: row.id, reason: 'panic' }),
    ),
  };

  const SUCCESS_PATHS = {
    list: () => listEncryptionKeys({ tenantId: TENANT }),
    register: () => registerEncryptionKey({ tenantId: TENANT, keyId: 'k-fresh' }),
    rotate: () => rotateActiveKey({ tenantId: TENANT, newKeyId: 'k-fresh' }),
    retire: () => retireEncryptionKey({ tenantId: TENANT, id: REGISTRY_ROW.id }),
    compromise: () => markKeyCompromised({ tenantId: TENANT, id: REGISTRY_ROW.id, reason: 'x' }),
  };

  const ACTIONS = Object.keys(ENCRYPTION_KEY_ACTION_FENCE);

  it('covers every action the module exposes', () => {
    expect(ACTIONS.sort()).toEqual(['compromise', 'list', 'register', 'retire', 'rotate']);
  });

  it.each(ACTIONS)('%s raises exactly the fence refusals it declares', async (action) => {
    installFakeTable(PROTECTED_FIXTURES);
    const raised = new Set();
    for (const run of REFUSAL_SCENARIOS[action]) {
      // Sequential on purpose: several scenarios share the one fake table.
      await run().then(
        () => { throw new Error(`${action}: a refusal scenario resolved instead of refusing`); },
        (err) => raised.add(err.code),
      );
    }
    expect([...raised].sort())
      .toEqual([...ENCRYPTION_KEY_ACTION_FENCE[action].refusal_codes].sort());
  });

  it.each(ACTIONS)('%s issues exactly the kinds of statement it declares', async (action) => {
    installFakeTable();
    await SUCCESS_PATHS[action]();
    const statements = queryUnsafeMock.mock.calls.map(([sql]) => sql);
    const fence = ENCRYPTION_KEY_ACTION_FENCE[action];
    expect(statements.some((sql) => /^\s*INSERT/.test(sql))).toBe(fence.creates_rows);
    expect(statements.some((sql) => /^\s*UPDATE/.test(sql))).toBe(fence.mutates_existing_rows);
  });

  it('list refuses nothing even when every visible row is withheld', async () => {
    installFakeTable(PROTECTED_FIXTURES);
    const result = await listEncryptionKeys({ tenantId: TENANT });
    expect(result.keys).toEqual([]);
    expect(result.protected_count).toBe(PROTECTED_FIXTURES.length);
    expect(ENCRYPTION_KEY_ACTION_FENCE.list.refusal_codes).toEqual([]);
  });

  it('pins the wire values the console switches on', () => {
    expect({ ...ENCRYPTION_KEY_REFUSAL_CODES }).toEqual({
      LIVE_MATERIAL: 'ENCRYPTION_KEY_LIVE_MATERIAL',
      SIGNING: 'ENCRYPTION_KEY_SIGNING_MATERIAL',
      OUT_OF_TENANT_SCOPE: 'ENCRYPTION_KEY_NOT_TENANT_SCOPED',
      UNPROVEN: 'ENCRYPTION_KEY_NOT_PROVABLY_INERT',
      RESERVED_KEY_ID: 'ENCRYPTION_KEY_ID_RESERVED',
      WOULD_BE_UNMANAGEABLE: 'ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE',
      METADATA_UNSTORABLE: 'ENCRYPTION_KEY_METADATA_UNSTORABLE',
      ROTATION_PREDECESSOR_PROTECTED: 'ENCRYPTION_KEY_ROTATION_PREDECESSOR_PROTECTED',
      SCHEMA_MISSING: 'ENCRYPTION_KEY_REGISTRY_SCHEMA_MISSING',
    });
    expect({ ...KEY_CLASSES }).toEqual({
      REGISTRY: 'registry_metadata',
      LIVE_MATERIAL: 'live_key_material',
      SIGNING: 'signing_key',
      UNPROVEN: 'unproven',
      OUT_OF_TENANT_SCOPE: 'out_of_tenant_scope',
    });
    // The cross-cutting 503 belongs to no single action.
    const declared = ACTIONS.flatMap((action) => ENCRYPTION_KEY_ACTION_FENCE[action].refusal_codes);
    for (const code of declared) expect(Object.values(ENCRYPTION_KEY_REFUSAL_CODES)).toContain(code);
    expect(declared).not.toContain(ENCRYPTION_KEY_REFUSAL_CODES.SCHEMA_MISSING);
  });
});

describe('a missing schema fails the same way everywhere', () => {
  const CASES = [
    ['listEncryptionKeys', () => listEncryptionKeys({ tenantId: TENANT })],
    ['registerEncryptionKey', () => registerEncryptionKey({ tenantId: TENANT, keyId: 'k1' })],
    ['rotateActiveKey', () => rotateActiveKey({ tenantId: TENANT, newKeyId: 'k1' })],
    ['retireEncryptionKey', () => retireEncryptionKey({ tenantId: TENANT, id: 1 })],
    ['markKeyCompromised', () => markKeyCompromised({ tenantId: TENANT, id: 1 })],
  ];

  it.each(CASES)('%s reports a missing relation instead of guessing', async (_label, call) => {
    queryUnsafeMock.mockRejectedValue(new Error('relation "encryption_keys" does not exist'));
    await expect(call()).rejects.toMatchObject({
      statusCode: 503,
      code: 'ENCRYPTION_KEY_REGISTRY_SCHEMA_MISSING',
    });
  });

  it.each(CASES)('%s reports a missing fence column too', async (_label, call) => {
    // Without `wrapped_key_material` (migration 337) the allowlist cannot be
    // evaluated at all, so nothing may proceed — least of all a mutation.
    queryUnsafeMock.mockRejectedValue(new Error('column "wrapped_key_material" does not exist'));
    await expect(call()).rejects.toMatchObject({
      statusCode: 503,
      code: 'ENCRYPTION_KEY_REGISTRY_SCHEMA_MISSING',
    });
  });

  it('does not report an empty registry when it cannot read one', async () => {
    queryUnsafeMock.mockRejectedValue(new Error('relation "encryption_keys" does not exist'));
    await expect(listEncryptionKeys({ tenantId: TENANT })).rejects.toThrow();
  });
});
