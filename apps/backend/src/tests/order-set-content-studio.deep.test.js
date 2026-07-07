import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import {
  approveOrderSet,
  cloneOrderSetVersion,
  importOrderSetDocument,
  listOrderSetsForStudio,
  recordPharmacyReview,
  rollbackOrderSet,
  submitOrderSetForReview,
} from '../services/emr/orderSetGovernanceService.js';
import { applyOrderSet, getOrderSets } from '../services/emr/orderEntryService.js';
import {
  __clearContentStudioSettingsCacheForTests,
  isContentStudioEnabled,
  setContentStudioEnabled,
} from '../services/emr/orderSetContentStudioSettingsService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '38100000-0000-4000-8000-000000000001';
const TENANT_B = '38200000-0000-4000-8000-000000000001';
const AUTHOR_UID = '38110000-0000-4000-8000-000000000001';
const APPROVER_UID = '38120000-0000-4000-8000-000000000001';
const PHARMACY_UID = '38130000-0000-4000-8000-000000000001';
const PATIENT_UID = '38140000-0000-4000-8000-000000000001';

const AUTHOR = { uid: AUTHOR_UID, role: 'CONSULTANT' };
const APPROVER = { uid: APPROVER_UID, role: 'QUALITY_OFFICER' };
const PHARMACY = { uid: PHARMACY_UID, role: 'PHARMACY_INCHARGE' };

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM order_set_review_events WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_order_set_items WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_order_sets WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM order_set_import_batches WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM content_studio_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM hipaa_access_log WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    AUTHOR_UID,
    APPROVER_UID,
    PHARMACY_UID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  __clearContentStudioSettingsCacheForTests();
}

async function seedTenant(id, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, status, updated_at)
     VALUES ($1::uuid, $2, $3, 'active', NOW())
     ON CONFLICT (id) DO UPDATE
       SET slug = EXCLUDED.slug, name = EXCLUDED.name, status = 'active', updated_at = NOW()`,
    id,
    slug,
    `Order Set Studio ${slug}`,
  );
}

async function seedUser(uid, tenantId, role, name, phoneSuffix) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, TRUE, 'active', NOW())
     ON CONFLICT (uid) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           phone = EXCLUDED.phone,
           name = EXCLUDED.name,
           role = EXCLUDED.role,
           is_active = TRUE,
           status = 'active',
           updated_at = NOW()`,
    uid,
    tenantId,
    `+91381${phoneSuffix}`,
    name,
    role,
  );
}

async function seedFixtures() {
  await seedTenant(TENANT_A, 'order-set-studio-a');
  await seedTenant(TENANT_B, 'order-set-studio-b');
  await seedUser(AUTHOR_UID, TENANT_A, 'CONSULTANT', 'Order Set Author', '000001');
  await seedUser(APPROVER_UID, TENANT_A, 'QUALITY_OFFICER', 'Order Set Approver', '000002');
  await seedUser(PHARMACY_UID, TENANT_A, 'PHARMACY_INCHARGE', 'Order Set Pharmacist', '000003');
  await seedUser(PATIENT_UID, TENANT_A, 'PATIENT', 'Order Set Patient', '000004');
}

async function createOrderSetRow({
  tenantId = TENANT_A,
  familyKey,
  code,
  status = 'draft',
  version = 1,
  active = true,
  items,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_order_sets
       (tenant_id, code, family_key, version, status, active, title, specialty,
        condition_codes, description, created_by, source)
     VALUES ($1::uuid, $2, $3, $4::int, $5, $6, $7, 'General Medicine',
             ARRAY[]::text[], 'Jest content-studio fixture', $8::uuid, 'authored')
     RETURNING *`,
    tenantId,
    code,
    familyKey,
    version,
    status,
    active,
    `${familyKey} fixture`,
    AUTHOR_UID,
  );
  const set = rows[0];
  for (const [index, item] of items.entries()) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_order_set_items
         (tenant_id, order_set_id, display_order, kind, payload, default_selected)
       VALUES ($1::uuid, $2::int, $3::int, $4, $5::jsonb, TRUE)`,
      tenantId,
      Number(set.id),
      index + 1,
      item.kind,
      JSON.stringify(item.payload),
    );
  }
  return set;
}

const labItem = {
  kind: 'lab',
  payload: { test_name: 'CBC', urgency: 'routine' },
};

const medicationItem = {
  kind: 'med',
  payload: {
    medication_name: 'Paracetamol',
    dose: '500 mg',
    route: 'PO',
    frequency: 'BD',
  },
};

d('NL-5 P3 order-set content studio governance', () => {
  beforeAll(async () => {
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('allows quality officers through the EMR parent gate to the studio queue', async () => {
    await setContentStudioEnabled(TENANT_A, true, { actorUid: APPROVER_UID });

    const res = await authClient('QUALITY_OFFICER', {
      uid: APPROVER_UID,
      tenant_id: TENANT_A,
    }).get('/api/v1/emr/order-sets/studio');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.any(Array));
  });

  test('governs draft review, pharmacy second review, deploy, clone, predecessor retirement, and rollback', async () => {
    await setContentStudioEnabled(TENANT_A, true, { actorUid: APPROVER_UID });
    expect(await isContentStudioEnabled(TENANT_A)).toBe(true);
    expect(await isContentStudioEnabled(TENANT_B)).toBe(false);

    const draft = await createOrderSetRow({
      familyKey: 'P3-LIFECYCLE',
      code: 'P3-LIFECYCLE-V1',
      items: [labItem, medicationItem],
    });

    const submitted = await submitOrderSetForReview({
      tenantId: TENANT_A,
      orderSetId: draft.id,
      actor: AUTHOR,
      note: 'ready',
    });
    expect(submitted.status).toBe('in_review');
    expect(submitted.requires_pharmacy_review).toBe(true);

    await expect(approveOrderSet({
      tenantId: TENANT_A,
      orderSetId: draft.id,
      actor: AUTHOR,
    })).rejects.toMatchObject({ code: 'ORDER_SET_SELF_APPROVAL_REJECTED' });

    await expect(approveOrderSet({
      tenantId: TENANT_A,
      orderSetId: draft.id,
      actor: APPROVER,
    })).rejects.toMatchObject({ code: 'ORDER_SET_PHARMACY_REVIEW_REQUIRED' });

    const pharmacyReviewed = await recordPharmacyReview({
      tenantId: TENANT_A,
      orderSetId: draft.id,
      actor: PHARMACY,
      note: 'medication review complete',
    });
    expect(pharmacyReviewed.has_pharmacy_review).toBe(true);

    const approved = await approveOrderSet({
      tenantId: TENANT_A,
      orderSetId: draft.id,
      actor: APPROVER,
      note: 'deploy',
    });
    expect(approved.status).toBe('approved');
    expect(approved.active).toBe(true);
    expect(approved.events.map((event) => event.action)).toEqual(expect.arrayContaining(['approve', 'deploy']));

    const successorDraft = await cloneOrderSetVersion({
      tenantId: TENANT_A,
      orderSetId: approved.id,
      actor: AUTHOR,
    });
    expect(successorDraft.version).toBe(2);
    expect(successorDraft.status).toBe('draft');

    await expect(applyOrderSet(PATIENT_UID, null, successorDraft.id, AUTHOR_UID, TENANT_A))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await submitOrderSetForReview({
      tenantId: TENANT_A,
      orderSetId: successorDraft.id,
      actor: AUTHOR,
    });
    await recordPharmacyReview({
      tenantId: TENANT_A,
      orderSetId: successorDraft.id,
      actor: PHARMACY,
    });
    const successor = await approveOrderSet({
      tenantId: TENANT_A,
      orderSetId: successorDraft.id,
      actor: APPROVER,
      note: 'deploy v2',
    });
    expect(successor.status).toBe('approved');

    const retiredRows = await prisma.$queryRawUnsafe(
      `SELECT status, active, superseded_by
         FROM clinical_order_sets
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(approved.id),
    );
    expect(retiredRows[0]).toMatchObject({
      status: 'retired',
      active: false,
      superseded_by: Number(successor.id),
    });

    await expect(applyOrderSet(PATIENT_UID, null, approved.id, AUTHOR_UID, TENANT_A))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const restored = await rollbackOrderSet({
      tenantId: TENANT_A,
      orderSetId: successor.id,
      actor: APPROVER,
      note: 'rollback',
    });
    expect(restored.id).toBe(Number(approved.id));
    expect(restored.status).toBe('approved');
  });

  test('apply stamps deployed family/version provenance and hides drafts from composer list', async () => {
    const deployed = await createOrderSetRow({
      familyKey: 'P3-APPLY',
      code: 'P3-APPLY-V1',
      status: 'approved',
      active: true,
      items: [labItem],
    });
    const draft = await createOrderSetRow({
      familyKey: 'P3-DARK',
      code: 'P3-DARK-V1',
      status: 'draft',
      active: true,
      items: [labItem],
    });

    const composerRows = await getOrderSets();
    expect(composerRows.some((row) => row.id === Number(draft.id))).toBe(false);

    const applied = await applyOrderSet(PATIENT_UID, null, deployed.id, AUTHOR_UID, TENANT_A);
    expect(applied).toHaveLength(1);
    expect(applied[0].order.details).toMatchObject({
      order_set_family: 'P3-APPLY',
      order_set_version: 1,
    });
  });

  test('imports validate without writing, land as idempotent drafts, and stay tenant-scoped', async () => {
    const document = {
      format: 'vh-order-set/1',
      family_key: 'P3-IMPORT',
      title: 'P3 imported pathway',
      specialty: 'General Medicine',
      condition_codes: ['J18.9'],
      items: [
        { kind: 'lab', payload: { test_name: 'CRP', urgency: 'routine' } },
        { kind: 'radiology', payload: { modality: 'xray', body_part: 'chest' } },
      ],
    };

    const dryRun = await importOrderSetDocument({
      tenantId: TENANT_A,
      document,
      actor: AUTHOR,
      dryRun: true,
      sourceFile: 'p3-import.json',
    });
    expect(dryRun).toMatchObject({
      dry_run: true,
      family_key: 'P3-IMPORT',
      row_count: 2,
      requires_pharmacy_review: false,
    });

    const noBatchRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM order_set_import_batches
        WHERE tenant_id = $1::uuid AND source_file = 'p3-import.json'`,
      TENANT_A,
    );
    expect(noBatchRows[0].count).toBe(0);

    const imported = await importOrderSetDocument({
      tenantId: TENANT_A,
      document,
      actor: AUTHOR,
      dryRun: false,
      sourceFile: 'p3-import.json',
    });
    const repeated = await importOrderSetDocument({
      tenantId: TENANT_A,
      document: {
        ...document,
        items: [{ kind: 'lab', payload: { test_name: 'ESR', urgency: 'routine' } }],
      },
      actor: AUTHOR,
      dryRun: false,
      sourceFile: 'p3-import.json',
    });
    expect(repeated.order_set.id).toBe(imported.order_set.id);
    expect(repeated.order_set.status).toBe('draft');
    expect(repeated.order_set.items).toHaveLength(1);

    await createOrderSetRow({
      tenantId: TENANT_B,
      familyKey: 'P3-OTHER-TENANT',
      code: 'P3-OTHER-TENANT-V1',
      status: 'draft',
      items: [labItem],
    });

    const tenantAQueue = await listOrderSetsForStudio({ tenantId: TENANT_A });
    expect(tenantAQueue.some((row) => row.family_key === 'P3-IMPORT')).toBe(true);
    expect(tenantAQueue.some((row) => row.family_key === 'P3-OTHER-TENANT')).toBe(false);
  });
});
