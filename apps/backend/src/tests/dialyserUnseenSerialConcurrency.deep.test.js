import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import prisma from '../lib/prisma.js';
import { captureDialyserTx, lockDialysisSessionTx } from '../services/clinical/dialysisDeviceLifecycleService.js';
import { createPlan4DialysisFixture, describeWithDatabase } from './helpers/plan4DialysisFixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

describeWithDatabase('dialyser unseen serial concurrency', () => {
  test('twentyBarrierRacesMintOneDeviceAndNeverTransferDedication', async () => {
    const fixture = await createPlan4DialysisFixture();
    const connections = [new Client({ connectionString: databaseUrl }), new Client({ connectionString: databaseUrl })];
    expect(connections).toHaveLength(2);
    await Promise.all(connections.map((client) => client.connect()));
    const otherUid = randomUUID();
    const other = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid,tenant_id,phone,name,role,is_active,status,updated_at)
       VALUES ($1::uuid,$2::uuid,$3,'Plan 4 concurrent patient','PATIENT',TRUE,'active',NOW()) RETURNING uid`,
      otherUid, fixture.tenantId, `+91${BigInt(`0x${otherUid.replaceAll('-', '').slice(0, 12)}`).toString().slice(-10)}`,
    );
    expect(other).toHaveLength(1);
    const [roster] = await prisma.$queryRawUnsafe(
      `INSERT INTO dialysis_patients (tenant_id,patient_uid,modality,status)
       VALUES ($1::uuid,$2::uuid,'hd','active') RETURNING id`, fixture.tenantId, otherUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_bloodborne_markers (tenant_id,patient_uid,marker,result,tested_on,source,recorded_by)
       SELECT tenant_id,$2::uuid,marker,result,tested_on,source,recorded_by
         FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND patient_uid = $3::uuid`,
      fixture.tenantId, otherUid, fixture.patientUid,
    );
    const iterations = Array.from({ length: 20 }, (_, index) => index);
    expect(iterations).toHaveLength(20);
    try {
      for (const iteration of iterations) {
        const serial = `PLAN4-RACE-${iteration}-${randomUUID()}`;
        const sessions = [await fixture.schedule(), await fixture.schedule({ dialysis_patient_id: roster.id })];
        expect(sessions).toHaveLength(2);
        let unblockFirst;
        let firstInserted;
        let secondInsertStarted;
        const firstInsert = new Promise((resolve) => { firstInserted = resolve; });
        const secondInsert = new Promise((resolve) => { secondInsertStarted = resolve; });
        const release = new Promise((resolve) => { unblockFirst = resolve; });
        const commands = connections.map((client, index) => async () => {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [fixture.tenantId]);
          const tx = {
            $queryRawUnsafe: async (sql, ...values) => {
              const mint = sql.includes('INSERT INTO reprocessable_devices');
              if (mint && index === 1) secondInsertStarted();
              const result = await client.query(sql, values);
              if (mint && index === 0) { firstInserted(); await release; }
              return result.rows;
            },
            $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
          };
          try {
            const { session } = await lockDialysisSessionTx(tx, { tenantId: fixture.tenantId, sessionId: sessions[index].id });
            const result = await captureDialyserTx(tx, {
              tenantId: fixture.tenantId, session, actor: fixture.actor,
              body: { manufacturer_serial: serial, manufacturer: fixture.manufacturer, model_name: fixture.modelName, baseline_tcv_ml: 100 },
            });
            await client.query('COMMIT');
            return { status: 'fulfilled', value: result };
          } catch (error) {
            await client.query('ROLLBACK');
            return { status: 'rejected', code: error.code };
          }
        });
        expect(commands).toHaveLength(2);
        const firstResult = commands[0]();
        await Promise.race([firstInsert, firstResult.then((result) => {
          if (result.status === 'rejected') throw new Error(`First capture failed before barrier: ${result.code}`);
        })]);
        const secondResult = commands[1]();
        await Promise.race([secondInsert, secondResult.then((result) => {
          if (result.status === 'rejected') throw new Error(`Second capture failed before barrier: ${result.code}`);
        })]);
        const started = Date.now();
        let lockObserved = false;
        while (Date.now() - started < 3000) {
          const waiting = await prisma.$queryRawUnsafe(
            `SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE pid = $1::int AND wait_event_type = 'Lock'`, connections[1].processID,
          );
          if (waiting[0].count === 1) { lockObserved = true; break; }
          await new Promise((resolve) => { setTimeout(resolve, 10); });
        }
        unblockFirst();
        const outcomes = await Promise.all([firstResult, secondResult]);
        expect(outcomes).toHaveLength(2);
        expect(lockObserved).toBe(true);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
        expect(outcomes[1].code).toBe('DIALYSER_DEDICATED_TO_ANOTHER_PATIENT');
        const identities = await prisma.$queryRawUnsafe(
          `SELECT d.id,l.dedicated_patient_uid FROM reprocessable_devices d
             JOIN reprocessable_device_dialysis_links l ON l.tenant_id=d.tenant_id AND l.device_id=d.id
            WHERE d.tenant_id=$1::uuid AND d.manufacturer_serial=$2`, fixture.tenantId, serial,
        );
        expect(identities).toHaveLength(1);
        expect(identities[0].dedicated_patient_uid).toBe(fixture.patientUid);
      }
    } finally {
      await Promise.all(connections.map((client) => client.end()));
      await fixture.cleanup();
    }
  }, 120000);
});
