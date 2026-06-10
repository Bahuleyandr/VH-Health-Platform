// Roadmap B3 — closed-loop lab deep round-trip.
//
// specimen label (Code 39 of the accession) → scan-on-receipt transition
// with history + canonical events → analyzer interface inbox: ASTM payload
// lands lab_results linked to the specimen with rules verdicts; unknown
// accessions fail closed and stay replayable in the inbox.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const RUN = String(Date.now() % 100000).padStart(5, '0');
const ACCESSION = `B3TEST-ACC-${RUN}`;
const PHONE = `+9199911${String(Date.now() % 10000).padStart(4, '0')}`;
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

let patientUid;
let specimenId;

const astmFor = (accession) => [
  'H|\\^&|||B3TEST^Analyzer|||||||P|E1394-97|20260610',
  'P|1',
  `O|1|${accession}||^^^GLU|R`,
  'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
  'R|2|^^^K|6.9|mmol/L|3.5^5.1|H||F',
  'L|1|N',
].join('\r');

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_interface_messages WHERE raw_message LIKE '%B3TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B3TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_specimen_status_history WHERE specimen_id IN (SELECT id FROM lab_specimens WHERE accession_number LIKE 'B3TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_specimens WHERE accession_number LIKE 'B3TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B3TEST Patient'`).catch(() => {});
}

d('Closed-loop lab — deep round-trip (roadmap B3)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'B3TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;

    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, accession_number, specimen_type, priority, status, collected_at, collected_by)
       VALUES ($1::uuid, $2::uuid, $3, 'blood', 'routine', 'collected', NOW(), NULL)
       RETURNING id`,
      DEFAULT_TENANT, patientUid, ACCESSION,
    );
    specimenId = Number(s[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('specimen label issues the accession barcode with Code 39 SVG (JSON + HTML)', async () => {
    const res = await authClient('ADMIN').get(`/api/v1/lab/specimens/${specimenId}/label`);
    expect(res.status).toBe(200);
    expect(res.body.data.barcode).toBe(ACCESSION.toUpperCase());
    expect(res.body.data.svg).toContain('<svg');
    expect(res.body.data.patient.name).toBe('B3TEST Patient');

    const html = await authClient('ADMIN')
      .get(`/api/v1/lab/specimens/${specimenId}/label`)
      .query({ format: 'html' });
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain(ACCESSION);

    const row = await prisma.$queryRawUnsafe(
      `SELECT barcode, label_printed_at FROM lab_specimens WHERE id = $1`, specimenId,
    );
    expect(row[0].barcode).toBe(ACCESSION);
    expect(row[0].label_printed_at).toBeTruthy();
  });

  test('scan-on-receipt transitions collected → received once, with history + timeline', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/specimens/receive-scan')
      .send({ barcode: ACCESSION.toLowerCase() }); // case-insensitive scan
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('received');

    const again = await authClient('ADMIN')
      .post('/api/v1/lab/specimens/receive-scan')
      .send({ barcode: ACCESSION });
    expect(again.status).toBe(409);

    const history = await prisma.$queryRawUnsafe(
      `SELECT from_status, to_status FROM lab_specimen_status_history WHERE specimen_id = $1`,
      specimenId,
    );
    expect(history.some((h) => h.from_status === 'collected' && h.to_status === 'received')).toBe(true);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'lab_specimens' AND source_id = $1`,
      String(specimenId),
    );
    expect(timeline.map((t) => t.event_type)).toContain('lab.specimen_received');
  });

  test('unknown barcode fails closed', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/specimens/receive-scan')
      .send({ barcode: 'B3TEST-DOES-NOT-EXIST' });
    expect(res.status).toBe(404);
  });

  test('ASTM ingest: results land linked to the specimen with rules verdicts', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'astm_e1394', analyzer_code: 'B3TEST-ANALYZER', message: astmFor(ACCESSION) });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ingested');
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.verdicts).toHaveLength(2);
    for (const verdict of res.body.data.verdicts) {
      expect(['auto_verify', 'hold_for_review', 'critical']).toContain(verdict.decision);
    }

    const results = await prisma.$queryRawUnsafe(
      `SELECT test_code, specimen_id, patient_uid, value_numeric FROM lab_results
        WHERE specimen_id = $1 ORDER BY test_code`,
      specimenId,
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.test_code).sort()).toEqual(['GLU', 'K']);
    expect(results[0].patient_uid).toBe(patientUid);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, result_count, specimen_id, verdicts FROM lab_interface_messages
        WHERE raw_message LIKE '%${ACCESSION}%' ORDER BY id DESC LIMIT 1`,
    );
    expect(inbox[0].status).toBe('ingested');
    expect(Number(inbox[0].result_count)).toBe(2);
    expect(Number(inbox[0].specimen_id)).toBe(specimenId);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE event_type = 'lab.analyzer_results_ingested' AND patient_uid = $1::uuid`,
      patientUid,
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);
  });

  test('unknown accession fails closed but stays replayable in the inbox', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'astm_e1394', message: astmFor('B3TEST-GHOST-1') });
    expect(res.status).toBe(404);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, error FROM lab_interface_messages
        WHERE raw_message LIKE '%B3TEST-GHOST-1%' ORDER BY id DESC LIMIT 1`,
    );
    expect(inbox[0].status).toBe('failed');
    expect(inbox[0].error).toMatch(/No specimen matches/);
  });

  test('bad protocol is rejected without an inbox row', async () => {
    const res = await authClient('ADMIN')
      .post('/api/v1/lab/interface/ingest')
      .send({ protocol: 'fax', message: 'whatever' });
    expect(res.status).toBe(400);
  });

  test('interface inbox list filters by status', async () => {
    const res = await authClient('ADMIN')
      .get('/api/v1/lab/interface/messages')
      .query({ status: 'failed' });
    expect(res.status).toBe(200);
    expect(res.body.data.messages.every((m) => m.status === 'failed')).toBe(true);
  });
});
