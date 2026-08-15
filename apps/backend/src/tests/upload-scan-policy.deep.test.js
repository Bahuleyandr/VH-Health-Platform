// End-to-end proof of the file-scan gate over real HTTP against a real row.
//
// The unit suites pin the decision; this pins that a request actually gets the
// decision. Both halves of the original defect are asserted here:
//
//   * the no-scanner deployment can RETRIEVE what it accepted (the reported bug
//     was a 201 followed by a permanent 423 with no indication at upload time);
//   * a quarantined file, and a legacy never-resolved 'pending'/'failed' file,
//     are STILL refused — the fix must not become "serve everything".
//
// FILE_SCAN_POLICY is read per call, so each case sets it and restores it.

import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const OWNER = 'c0de0674-0000-4000-8000-000000000001';
const KEY_PREFIX = `uploads/${OWNER}/scanpolicy_`;

function owner() {
  const t = generateTestToken('PATIENT', { uid: OWNER, tenant_id: TENANT });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`),
  };
}

async function seed(name, scanStatus) {
  const key = `${KEY_PREFIX}${name}.pdf`;
  await prisma.$executeRawUnsafe(`DELETE FROM file_metadata WHERE storage_key = $1`, key);
  await prisma.$executeRawUnsafe(
    `INSERT INTO file_metadata
       (file_name, file_type, storage_key, storage_url, file_size,
        uploaded_by, scan_status, privacy_level, is_active, tenant_id, updated_at)
     VALUES ($1,'application/pdf',$2,'r2://x',123,$3::uuid,$4,'RESTRICTED',TRUE,$5::uuid,NOW())`,
    `${name}.pdf`, key, OWNER, scanStatus, TENANT);
  return key;
}

async function statusFor(key) {
  const res = await owner().get(`/api/v1/upload/by-key/${key}`);
  return res.statusCode;
}

d('Generic upload by-key scan-policy gate', () => {
  let previousPolicy;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM file_metadata WHERE storage_key LIKE $1`, `${KEY_PREFIX}%`);
  }, 30000);

  beforeEach(() => { previousPolicy = process.env.FILE_SCAN_POLICY; });
  afterEach(() => {
    if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
    else process.env.FILE_SCAN_POLICY = previousPolicy;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM file_metadata WHERE storage_key LIKE $1`, `${KEY_PREFIX}%`).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('serves a not_scanned file where the deployment declared it runs without a scanner', async () => {
    process.env.FILE_SCAN_POLICY = 'disabled_accepted_risk';
    const key = await seed('notscanned_disabled', 'not_scanned');
    expect(await statusFor(key)).toBe(200);
  }, 30000);

  it('blocks that same not_scanned file the moment scanning is required', async () => {
    const key = await seed('notscanned_required', 'not_scanned');
    process.env.FILE_SCAN_POLICY = 'required';
    expect(await statusFor(key)).toBe(423);
  }, 30000);

  it('serves a clean file under BOTH policies', async () => {
    const key = await seed('clean_both', 'clean');
    for (const policy of ['required', 'disabled_accepted_risk']) {
      process.env.FILE_SCAN_POLICY = policy;
      expect(await statusFor(key)).toBe(200);
    }
  }, 30000);

  it('NEVER serves a quarantined file, under either policy', async () => {
    const key = await seed('quarantined_both', 'quarantined');
    for (const policy of ['required', 'disabled_accepted_risk']) {
      process.env.FILE_SCAN_POLICY = policy;
      expect(await statusFor(key)).toBe(423);
    }
  }, 30000);

  it('NEVER serves a legacy pending/failed file, under either policy', async () => {
    // The one-line "fix" for the reported bug would have been to add these to
    // the clean set. That would serve never-scanned bytes; this asserts it did
    // not happen.
    for (const legacy of ['PENDING', 'failed']) {
      const key = await seed(`legacy_${legacy.toLowerCase()}`, legacy);
      for (const policy of ['required', 'disabled_accepted_risk']) {
        process.env.FILE_SCAN_POLICY = policy;
        expect(await statusFor(key)).toBe(423);
      }
    }
  }, 30000);
});
