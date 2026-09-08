import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { isolationDecisionTx, reuseEligibilityTx } from '../services/clinical/dialysisReuseService.js';

const describeWithDatabase = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  ? describe : describe.skip;
const REFUSAL = { verdict: 'not_established', reason_codes: ['RPD_REUSE_EVIDENCE_REQUIRED'] };
const ELIGIBLE = { verdict: 'eligible', reason_codes: [] };
const protocol = {
  domain: 'dialysis', category: 'dialyser', status: 'active',
  reuse_matrix: { hbsag: 'no_reuse', hcv: 'dedicated_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse' },
  surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
};

async function withRnaFixture(run) {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const reporterUid = randomUUID();
  const rollback = new Error('ROLLBACK_HCV_RNA_FIXTURE');
  try {
    await setTenantTx(tenantId, async (tx) => {
      const tenants = [tenantId, otherTenantId];
      expect(tenants).toHaveLength(2);
      for (const tid of tenants) {
        await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tid);
        await tx.$executeRawUnsafe(
          "INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Persisted RNA evidence')",
          tid, `plan4-rna-${tid}`,
        );
      }
      await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
      const users = [{ uid: patientUid, role: 'PATIENT' }, { uid: reporterUid, role: 'DOCTOR' }];
      expect(users).toHaveLength(2);
      for (const user of users) {
        await tx.$executeRawUnsafe(
          `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, 'Persisted RNA fixture', $4, TRUE, 'active', NOW())`,
          user.uid, tenantId, `+91${BigInt(`0x${user.uid.replaceAll('-', '').slice(0, 12)}`)
            .toString().padStart(10, '0').slice(-10)}`, user.role,
        );
      }
      const [{ id: patientId }] = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
         VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`, tenantId, patientUid,
      );
      const [{ id: otherPatientId }] = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
         VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`, tenantId, randomUUID(),
      );
      await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", otherTenantId);
      const [{ id: otherTenantPatientId }] = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
         VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`, otherTenantId, patientUid,
      );
      await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
      const [{ now }] = await tx.$queryRawUnsafe('SELECT CURRENT_TIMESTAMP AS now');
      const today = now.toISOString().slice(0, 10);
      await tx.$executeRawUnsafe(
        `INSERT INTO patient_bloodborne_markers
           (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
         VALUES ($1::uuid, $2::uuid, 'hcv', 'reactive', $3::date,
                 'clinical_declaration', $4::uuid)`, tenantId, patientUid, today, reporterUid,
      );
      const request = {
        tenantId, patientUid, db: tx, protocol, dedicatedPatientUid: patientUid,
        asOf: now.toISOString(),
        device: { domain: 'dialysis', category: 'dialyser', cycle_count: 0, max_cycles_snapshot: 4 },
      };
      await run({
        tx, tenantId, patientUid, request,
        async rna(hcvPcr, ageDays = 0, { reportedBy = reporterUid, target = 'patient' } = {}) {
          const tid = target === 'other_tenant' ? otherTenantId : tenantId;
          const pid = target === 'other_tenant' ? otherTenantPatientId
            : (target === 'other_patient' ? otherPatientId : patientId);
          await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tid);
          await tx.$executeRawUnsafe(
            `INSERT INTO dialysis_serology
               (tenant_id, dialysis_patient_id, test_date, hcv_pcr, reported_by)
             VALUES ($1::uuid, $2::int, $3::date - $4::int, $5, $6::uuid)`,
            tid, pid, today, ageDays, hcvPcr, reportedBy,
          );
          await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
        },
        async eligible(overrides = {}) { return reuseEligibilityTx({ ...request, ...overrides }); },
      });
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describeWithDatabase('persisted HCV RNA evidence database boundary', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  test('persistedHcvRnaIgnoresOtherTenantAndOtherPatientEvidenceWithPositiveControl', async () => {
    await withRnaFixture(async ({ rna, eligible }) => {
      await rna('not_detected', 0, { target: 'other_tenant' });
      await rna('not_detected', 0, { target: 'other_patient' });
      await expect(eligible()).resolves.toEqual(REFUSAL);
      await rna('not_detected');
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
    });
  });

  test('persistedHcvRnaLaterDetectedContradictsEarlierNotDetected', async () => {
    await withRnaFixture(async ({ rna, eligible }) => {
      await rna('not_detected', 1);
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
      await rna('detected');
      await expect(eligible()).resolves.toEqual(REFUSAL);
    });
  });

  test('persistedHcvRnaMostRecentQualifyingRecordDecidesWithoutChangingResolverRestriction', async () => {
    await withRnaFixture(async ({ rna, eligible, tx, tenantId, patientUid }) => {
      await rna('detected', 1);
      await expect(eligible()).resolves.toEqual(REFUSAL);
      await rna('not_detected');
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
      await expect(isolationDecisionTx({ tenantId, patientUid, db: tx }))
        .resolves.toMatchObject({ status: 'restricted' });
      const rows = await tx.$queryRawUnsafe(
        `SELECT marker, result, voided_at FROM patient_bloodborne_markers
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`, tenantId, patientUid,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ marker: 'hcv', result: 'reactive', voided_at: null });
    });
  });

  test('persistedHcvRnaLatestPendingNeverFallsBackToEarlierNotDetected', async () => {
    await withRnaFixture(async ({ rna, eligible }) => {
      await rna('not_detected', 1);
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
      await rna('pending');
      await expect(eligible()).resolves.toEqual(REFUSAL);
    });
  });

  test('persistedHcvRnaLatestInvalidNeverFallsBackToEarlierNotDetected', async () => {
    await withRnaFixture(async ({ rna, eligible }) => {
      await rna('not_detected', 1);
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
      await rna('negative');
      await expect(eligible()).resolves.toEqual(REFUSAL);
    });
  });

  test('persistedHcvRnaLatestUnattributedNeverFallsBackToEarlierNotDetected', async () => {
    await withRnaFixture(async ({ rna, eligible }) => {
      await rna('not_detected', 1);
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
      await rna('not_detected', 0, { reportedBy: null });
      await expect(eligible()).resolves.toEqual(REFUSAL);
    });
  });

  test('persistedHcvRnaOverdueRecordCannotEstablishDedicatedReuse', async () => {
    await withRnaFixture(async ({ rna, eligible }) => {
      await rna('not_detected', 91);
      await expect(eligible()).resolves.toEqual(REFUSAL);
      await rna('not_detected', 90);
      await expect(eligible()).resolves.toEqual(ELIGIBLE);
    });
  });
});
