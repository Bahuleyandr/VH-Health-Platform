import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import { errorHandlerMiddleware } from '../middleware/errorHandlerMiddleware.js';
import tenantRoutes from '../routes/admin/tenantRoutes.js';

const TENANT_ID = 'ca4e0000-0000-4000-8000-000000000401';
const ACTOR_UID = 'ca4e0000-0000-4000-8000-000000000402';
const PATHWAY_KEY = 'diagnostics_order_to_action';
const SLUG_PREFIX = 's4-pathway-settings-guard';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR_UID, role: 'SUPER_ADMIN' };
  next();
});
app.use('/api/v1/admin/tenants', tenantRoutes);
app.use(errorHandlerMiddleware);

const RESERVED_SETTINGS = [
  ['active', { [PATHWAY_KEY]: 'active' }],
  ['shadow', { [PATHWAY_KEY]: 'shadow' }],
  ['off', { [PATHWAY_KEY]: 'off' }],
  ['null', null],
  ['array', []],
  ['scalar', 'active'],
];
const INVALID_SETTINGS_ROOTS = [
  ['null', null],
  ['array', []],
  ['string', 'care_pathways'],
  ['number', 7],
  ['boolean', false],
];

async function replaceSettings(settings) {
  await prisma.$executeRawUnsafe(
    `UPDATE tenants
        SET settings = $2::jsonb,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    TENANT_ID,
    JSON.stringify(settings),
  );
}

async function loadSettings() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT settings FROM tenants WHERE id = $1::uuid',
    TENANT_ID,
  );
  return rows[0]?.settings;
}

async function waitForBlockedGenericSettingsUpdate() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND state = 'active'
          -- Identify the GENERIC settings update by the reserved-key preserving
          -- jsonb_build_object, not by the shape of the assignment. The old
          -- pattern pinned the literal 'settings = CASE', which stopped
          -- matching the moment the statement was rewritten to
          -- 'settings = $n::jsonb || CASE …' to preserve a second reserved key
          -- — the probe then silently never matched and the test failed with
          -- "did not block" even though the blocking behaviour was intact.
          -- The concurrent DEDICATED write uses jsonb_set, so it cannot match
          -- this pattern; the state = 'active' filter above already excludes it
          -- anyway while it sits idle in its transaction.
          AND query ILIKE '%UPDATE tenants%SET%jsonb_build_object%care_pathways%'`,
    );
    if (rows.some((row) => row.wait_event_type === 'Lock')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Generic settings update did not block on the dedicated mode write');
}

describe('tenant care-pathway settings HTTP boundary', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM tenants WHERE id = $1::uuid OR slug LIKE $2',
      TENANT_ID,
      `${SLUG_PREFIX}%`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, $2, 'S4 Settings Guard Tenant', 'IN', 'DPDP', 'active',
          $3::jsonb, NOW(), NOW())`,
      TENANT_ID,
      `${SLUG_PREFIX}-existing`,
      JSON.stringify({
        branding: { name: 'Before' },
        care_pathways: { [PATHWAY_KEY]: 'off' },
      }),
    );
  // Admin surface is entitlement-gated barrel-wide (once-over 2026-08-23):
  // give every test tenant a package, mirroring production provisioning.
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenant_entitlements (tenant_id, package_key, status, starts_at, source)
     SELECT id, 'enterprise', 'active', NOW(), 'test_seed' FROM tenants
     ON CONFLICT (tenant_id, package_key) DO NOTHING`,
  );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM tenants WHERE id = $1::uuid OR slug LIKE $2',
      TENANT_ID,
      `${SLUG_PREFIX}%`,
    ).catch(() => {});
    await prisma.$disconnect();
  });

  it.each(RESERVED_SETTINGS)(
    'rejects generic POST with reserved care_pathways=%s and creates no tenant',
    async (label, carePathways) => {
      const slug = `${SLUG_PREFIX}-post-${label}`;
      const response = await request(app)
        .post('/api/v1/admin/tenants')
        .send({
          slug,
          name: `Rejected ${label}`,
          settings: { care_pathways: carePathways },
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_SETTINGS_RESERVED');
      const rows = await prisma.$queryRawUnsafe(
        'SELECT id FROM tenants WHERE slug = $1',
        slug,
      );
      expect(rows).toHaveLength(0);
    },
  );

  it.each(INVALID_SETTINGS_ROOTS)(
    'rejects generic POST with a non-object settings %s and creates no tenant',
    async (label, settings) => {
      const slug = `${SLUG_PREFIX}-invalid-post-${label}`;
      const response = await request(app)
        .post('/api/v1/admin/tenants')
        .send({
          slug,
          name: `Rejected invalid ${label}`,
          settings,
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('TENANT_SETTINGS_INVALID');
      const rows = await prisma.$queryRawUnsafe(
        'SELECT id FROM tenants WHERE slug = $1',
        slug,
      );
      expect(rows).toHaveLength(0);
    },
  );

  it.each(RESERVED_SETTINGS)(
    'rejects generic PATCH with reserved care_pathways=%s without changing settings',
    async (_label, carePathways) => {
      const before = {
        branding: { name: 'Before' },
        care_pathways: {
          [PATHWAY_KEY]: 'off',
          nested_evidence: { checksum: 'exact-value-must-survive' },
        },
      };
      await replaceSettings(before);

      const response = await request(app)
        .patch(`/api/v1/admin/tenants/${TENANT_ID}`)
        .send({
          settings: {
            branding: { name: 'Bypass Attempt' },
            care_pathways: carePathways,
          },
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_SETTINGS_RESERVED');
      expect(await loadSettings()).toEqual(before);
    },
  );

  it.each(INVALID_SETTINGS_ROOTS)(
    'rejects generic PATCH with a non-object settings %s without changing settings',
    async (_label, settings) => {
      const before = {
        branding: { name: 'Before' },
        care_pathways: { [PATHWAY_KEY]: 'shadow' },
      };
      await replaceSettings(before);

      const response = await request(app)
        .patch(`/api/v1/admin/tenants/${TENANT_ID}`)
        .send({ settings });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('TENANT_SETTINGS_INVALID');
      expect(await loadSettings()).toEqual(before);
    },
  );

  it('atomically preserves the exact reserved subtree on an unrelated replacement', async () => {
    const carePathways = {
      [PATHWAY_KEY]: 'shadow',
      nested_evidence: {
        checksum: '4d231229a9046ed4c73e8f97130a0f9157874163286b268813f49c1ead7a9cb0',
        sequence: [1, 2, 3],
      },
    };
    await replaceSettings({
      legacy_setting: { should_be_replaced: true },
      care_pathways: carePathways,
    });

    const response = await request(app)
      .patch(`/api/v1/admin/tenants/${TENANT_ID}`)
      .send({ settings: { branding: { name: 'Updated Hospital' } } });

    expect(response.status).toBe(200);
    expect(await loadSettings()).toEqual({
      branding: { name: 'Updated Hospital' },
      care_pathways: carePathways,
    });
  });

  it('does not lose a concurrent dedicated shadow-mode write', async () => {
    await replaceSettings({
      legacy_setting: true,
      care_pathways: { [PATHWAY_KEY]: 'off' },
    });

    let releaseDedicatedWrite;
    let reportDedicatedWriteLocked;
    const dedicatedWriteLocked = new Promise((resolve) => {
      reportDedicatedWriteLocked = resolve;
    });
    const holdDedicatedWrite = new Promise((resolve) => {
      releaseDedicatedWrite = resolve;
    });

    const dedicatedWrite = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM tenants WHERE id = $1::uuid FOR UPDATE',
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE tenants
            SET settings = jsonb_set(
                  settings,
                  ARRAY['care_pathways', $2::text],
                  to_jsonb($3::text),
                  TRUE
                ),
                updated_at = NOW()
          WHERE id = $1::uuid`,
        TENANT_ID,
        PATHWAY_KEY,
        'shadow',
      );
      reportDedicatedWriteLocked();
      await holdDedicatedWrite;
    });

    await dedicatedWriteLocked;
    const genericPatch = request(app)
      .patch(`/api/v1/admin/tenants/${TENANT_ID}`)
      .send({ settings: { branding: { name: 'Concurrent Update' } } })
      .then((response) => response);

    try {
      await waitForBlockedGenericSettingsUpdate();
    } finally {
      releaseDedicatedWrite();
    }

    const response = await genericPatch;
    await dedicatedWrite;
    expect(response.status).toBe(200);
    expect(await loadSettings()).toEqual({
      branding: { name: 'Concurrent Update' },
      care_pathways: { [PATHWAY_KEY]: 'shadow' },
    });
  });
});
