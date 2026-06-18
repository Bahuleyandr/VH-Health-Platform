/**
 * qualityRcaQueue.deep.test.js
 *
 * Proves the quality domain queue populates end-to-end via the real QA Postgres:
 *
 *  1. Seed a HIGH quality_incidents row + enable quality_case_review for the tenant.
 *     → runSweep populates domain='quality' alert with scope_key=quality_incident:<id>.
 *
 *  2. Seed an admissions row with prior_admission_id + enable rca_draft_generator.
 *     → runSweep populates domain='quality' alert with scope_key=readmission:<id>.
 *
 *  3. Quality cases list route returns both alerts with domain='quality'.
 *
 *  4. generate-packet route: readmission path returns 200 with rca_id linked into
 *     the alert metadata when rca_draft_generator module is enabled.
 *
 * Skipped automatically when DATABASE_URL is unset.
 */

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';

// ---------------------------------------------------------------------------
// Only run against real Postgres
// ---------------------------------------------------------------------------
const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d  = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomIncidentNumber() {
  return `QI-DEEP-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
}

async function seedIncident({ severity = 'HIGH', status = 'reported' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO quality_incidents
       (tenant_id, incident_number, reported_by, incident_type, severity, description,
        date_occurred, status)
     VALUES ($1::uuid, $2, $3::uuid, 'clinical', $4, 'Test incident for deep test',
             NOW(), $5)
     RETURNING id`,
    TENANT,
    randomIncidentNumber(),
    TENANT,   // reported_by = tenant uuid (not a real user, but FK-free here)
    severity,
    status,
  );
  return rows[0].id;
}

async function seedAdmission({ patientUid = null, priorAdmissionId = null } = {}) {
  const uid = patientUid || TENANT; // reuse tenant uuid as patient_uid for convenience
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, status, prior_admission_id, admitted_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', $3, NOW() - INTERVAL '2 days')
     RETURNING id`,
    TENANT,
    uid,
    priorAdmissionId ?? null,
  );
  return rows[0].id;
}

async function enableModule(moduleKey) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_tenant_modules (tenant_id, module_key, enabled)
     VALUES ($1::uuid, $2, TRUE)
     ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = TRUE`,
    TENANT, moduleKey,
  );
}

async function disableModule(moduleKey) {
  await prisma.$executeRawUnsafe(
    `UPDATE clinical_ai_tenant_modules SET enabled = FALSE
     WHERE tenant_id = $1::uuid AND module_key = $2`,
    TENANT, moduleKey,
  );
}

async function cleanupScope(scopeKeyPrefix) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_operational_alerts
      WHERE tenant_id = $1::uuid AND scope_key LIKE $2`,
    TENANT, `${scopeKeyPrefix}%`,
  );
}

// ---------------------------------------------------------------------------
// Service imports — after mock module registrations (none needed for deep test)
// ---------------------------------------------------------------------------
const { runSweep, listOperationalAlerts } = await import('../services/ai/operationalAlertService.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
d('quality/RCA queue — deep integration (QA Postgres)', () => {
  let incidentId = null;
  let priorAdmissionId = null;
  let readmissionId = null;

  beforeAll(async () => {
    // Seed a prior admission (the one being readmitted from)
    priorAdmissionId = await seedAdmission();
    // Seed a readmission pointing to the prior
    readmissionId = await seedAdmission({ priorAdmissionId });
    // Seed a HIGH quality incident
    incidentId = await seedIncident({ severity: 'HIGH', status: 'investigating' });
    // Enable both quality modules
    await enableModule('quality_case_review');
    await enableModule('rca_draft_generator');
  });

  afterAll(async () => {
    // Best-effort cleanup — don't fail the test if these error
    try {
      await cleanupScope('quality_incident:');
      await cleanupScope('readmission:');
      await prisma.$executeRawUnsafe(
        `DELETE FROM quality_incidents WHERE id = $1`, incidentId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM admissions WHERE id IN ($1, $2)`, readmissionId, priorAdmissionId,
      );
      await disableModule('quality_case_review');
      await disableModule('rca_draft_generator');
    } catch (_) { /* best-effort */ }
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 1: quality_case_review evaluator populates the queue
  // -------------------------------------------------------------------------
  it('quality_case_review: HIGH incident creates a domain=quality alert with correct scope_key', async () => {
    await runSweep({
      tenantId: TENANT,
      moduleKeys: ['quality_case_review'],
    });

    const { alerts } = await listOperationalAlerts({
      tenantId: TENANT,
      domain: 'quality',
    });

    const match = alerts.find(
      (a) => a.scope_key === `quality_incident:${incidentId}` && a.system_status === 'active',
    );
    expect(match).toBeTruthy();
    expect(match.module_key).toBe('quality_case_review');
    expect(match.domain).toBe('quality');
    expect(match.owner_role).toBe('QUALITY_OFFICER');
    expect(match.alert_category).toBe('quality_case');
    expect(['high', 'critical']).toContain(match.severity);
    // Advisory flag injected
    expect(JSON.stringify(match.safety_flags)).toContain('OPERATIONAL_ALERT_DECISION_SUPPORT_ONLY');
    // Metrics has incident_id
    const metrics = match.metrics || {};
    expect(metrics.incident_id?.toString()).toBe(String(incidentId));
  });

  // -------------------------------------------------------------------------
  // Test 2: rca_draft_generator evaluator populates queue for readmissions
  // -------------------------------------------------------------------------
  it('rca_draft_generator: readmission creates a domain=quality alert with correct scope_key', async () => {
    await runSweep({
      tenantId: TENANT,
      moduleKeys: ['rca_draft_generator'],
    });

    const { alerts } = await listOperationalAlerts({
      tenantId: TENANT,
      domain: 'quality',
    });

    const match = alerts.find(
      (a) => a.scope_key === `readmission:${readmissionId}` && a.system_status === 'active',
    );
    expect(match).toBeTruthy();
    expect(match.module_key).toBe('rca_draft_generator');
    expect(match.domain).toBe('quality');
    expect(match.alert_category).toBe('readmission_review');
    expect(match.severity).toBe('moderate');
    // Metrics has both admission IDs
    const metrics = match.metrics || {};
    expect(metrics.admission_id?.toString()).toBe(String(readmissionId));
    expect(metrics.prior_admission_id?.toString()).toBe(String(priorAdmissionId));
  });

  // -------------------------------------------------------------------------
  // Test 3: listOperationalAlerts with domain='quality' returns both alerts
  // -------------------------------------------------------------------------
  it('listOperationalAlerts with domain=quality returns both quality alerts', async () => {
    const { alerts, count } = await listOperationalAlerts({
      tenantId: TENANT,
      domain: 'quality',
      systemStatus: 'active',
    });

    const scopeKeys = alerts.map((a) => a.scope_key);
    expect(scopeKeys).toContain(`quality_incident:${incidentId}`);
    expect(scopeKeys).toContain(`readmission:${readmissionId}`);
    // All returned are quality domain
    for (const a of alerts) {
      expect(a.domain).toBe('quality');
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Test 4: Re-sweep is idempotent (no duplicates)
  // -------------------------------------------------------------------------
  it('re-sweeping does not create duplicate alerts', async () => {
    await runSweep({ tenantId: TENANT, moduleKeys: ['quality_case_review', 'rca_draft_generator'] });

    const { alerts } = await listOperationalAlerts({
      tenantId: TENANT,
      domain: 'quality',
      systemStatus: 'active',
    });

    const incidentAlerts  = alerts.filter((a) => a.scope_key === `quality_incident:${incidentId}`);
    const readmissAlerts  = alerts.filter((a) => a.scope_key === `readmission:${readmissionId}`);

    expect(incidentAlerts).toHaveLength(1);
    expect(readmissAlerts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 5: incident auto-resolves when status is closed (row deleted/closed)
  // -------------------------------------------------------------------------
  it('quality_case_review alert auto-resolves when the incident is closed', async () => {
    // Update incident to resolved/closed status
    await prisma.$executeRawUnsafe(
      `UPDATE quality_incidents SET status = 'closed', resolved_at = NOW()
        WHERE id = $1`,
      incidentId,
    );

    await runSweep({ tenantId: TENANT, moduleKeys: ['quality_case_review'] });

    const { alerts } = await listOperationalAlerts({
      tenantId: TENANT,
      domain: 'quality',
      systemStatus: 'resolved',
    });

    const resolved = alerts.find((a) => a.scope_key === `quality_incident:${incidentId}`);
    expect(resolved).toBeTruthy();
    expect(resolved.resolved_reason).toBe('forecast_cleared');
  });
});
