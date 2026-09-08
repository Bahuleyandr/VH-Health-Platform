import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import {
  createProtocolDeviceScopeTx,
  createProtocolRevisionTx,
} from '../../services/clinical/reprocessingProtocolService.js';

export const describeWithDatabase = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  ? describe : describe.skip;

const CLEANUP_STATEMENTS = Object.freeze([
  'DELETE FROM bloodborne_exposure_applications WHERE tenant_id = $1::uuid',
  'DELETE FROM bloodborne_exposure_deliveries WHERE tenant_id = $1::uuid',
  'DELETE FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid',
  'DELETE FROM notification_outbox WHERE tenant_id = $1::uuid',
  'DELETE FROM notifications WHERE tenant_id = $1::uuid',
  'DELETE FROM clinical_alerts WHERE tenant_id = $1::uuid',
  'DELETE FROM cds_alerts WHERE tenant_id = $1::uuid',
  'DELETE FROM medication_safety_reviews WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessable_device_operations WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessable_hold_satisfactions WHERE tenant_id = $1::uuid',
  'DELETE FROM dialyser_reprocessing_attempts WHERE tenant_id = $1::uuid',
  'DELETE FROM device_processing_event_revisions WHERE tenant_id = $1::uuid',
  'DELETE FROM device_processing_events WHERE tenant_id = $1::uuid',
  'DELETE FROM dialyzer_reuse_register WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessable_device_holds WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessable_device_usages WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessable_device_dialysis_links WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessable_devices WHERE tenant_id = $1::uuid',
  'DELETE FROM dialysis_machines WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessing_domain_policies WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessing_domain_settings WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessing_protocol_device_scopes WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessing_protocols WHERE tenant_id = $1::uuid',
  'DELETE FROM reprocessing_isolation_setting_revisions WHERE tenant_id = $1::uuid',
  'DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid',
  'DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid',
  'DELETE FROM audit_logs WHERE tenant_id = $1::uuid',
  'DELETE FROM dialysis_sessions WHERE tenant_id = $1::uuid',
  'DELETE FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid',
  'DELETE FROM dialysis_patients WHERE tenant_id = $1::uuid',
  'DELETE FROM users WHERE tenant_id = $1::uuid',
  'DELETE FROM tenants WHERE id = $1::uuid',
]);

export function assertMarkerFree(value) {
  expect(JSON.stringify(value, (_, entry) => (
    typeof entry === 'bigint' ? String(entry) : entry
  ))).not.toMatch(/hbsag|\bhbv\b|\bhcv\b|\bhiv\b|hepatitis|isolation_mixed/i);
}

export async function createPlan4DialysisFixture({
  maxCycles = 3, activePolicy = true, clearMarkers = true,
} = {}) {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const actor = { uid: randomUUID(), role: 'DOCTOR' };
  const infectionControlActor = { uid: randomUUID(), role: 'INFECTION_CONTROL_OFFICER' };
  const manufacturer = 'Plan 4 test manufacturer';
  const modelName = 'Plan 4 test model';
  const users = [
    { uid: patientUid, role: 'PATIENT' }, actor, infectionControlActor,
  ];
  const fixture = await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(
      "INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Plan 4 dialysis lifecycle')",
      tenantId, `plan4-dialysis-${tenantId}`,
    );
    expect(users).toHaveLength(3);
    for (const user of users) {
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Plan 4 lifecycle fixture', $4, TRUE, 'active', NOW())`,
        user.uid, tenantId, `+91${BigInt(`0x${user.uid.replaceAll('-', '').slice(0, 12)}`)
          .toString().padStart(10, '0').slice(-10)}`, user.role,
      );
    }
    const [patient] = await tx.$queryRawUnsafe(
      `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
       VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`, tenantId, patientUid,
    );
    const [{ today }] = await tx.$queryRawUnsafe('SELECT current_date::text AS today');
    const markers = ['hbsag', 'hcv', 'hiv'];
    expect(markers).toHaveLength(3);
    if (clearMarkers) {
      for (const marker of markers) {
        await tx.$executeRawUnsafe(
          `INSERT INTO patient_bloodborne_markers
             (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
           VALUES ($1::uuid, $2::uuid, $3, 'non_reactive', $4::date,
                   'clinical_declaration', $5::uuid)`,
          tenantId, patientUid, marker, today, infectionControlActor.uid,
        );
      }
    }
    const protocol = await createProtocolRevisionTx(tx, {
      tenantId,
      input: {
        protocol_key: randomUUID(), domain: 'dialysis', category: 'dialyser',
        name: 'Plan 4 lifecycle protocol', basis: 'manufacturer_ifu',
        reference: 'PLAN4-LIFECYCLE-IFU', approved_by: infectionControlActor.uid,
        approved_role: infectionControlActor.role, approved_at: `${today}T00:00:00.000Z`,
        status: 'active', tcv_min_pct: 80, baseline_tcv_required: true,
        mid_life_enrolment_rule: 'refuse', residual_test_required: true,
        integrity_test_required: true,
        agents: [{
          agent: 'peracetic_acid', min_concentration_pct: 0.2,
          max_concentration_pct: 0.4, min_contact_minutes: 11,
        }],
        reuse_matrix: {
          hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse',
        },
        surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
        surveillance_overdue_blocks_reuse: true, prion_rule: 'discard',
        created_by: infectionControlActor.uid,
      },
    });
    const scope = await createProtocolDeviceScopeTx(tx, {
      tenantId, protocolId: protocol.id,
      input: {
        category: 'dialyser', manufacturer, model_name: modelName,
        ifu_reference: 'PLAN4-LIFECYCLE-IFU', nominal_tcv_ml: 100, single_use: false,
        approved_at: `${today}T00:00:00.000Z`, created_by: infectionControlActor.uid,
      },
    });
    if (activePolicy) {
      await tx.$executeRawUnsafe(
        `INSERT INTO reprocessing_domain_policies
           (tenant_id, domain, category, reprocessable, max_cycles,
            allowed_cycle_types, tcv_min_pct, protocol_id, updated_by)
         VALUES ($1::uuid, 'dialysis', 'dialyser', TRUE, $2::int,
                 ARRAY['chemical'], 80, $3::int, $4::uuid)`,
        tenantId, maxCycles, protocol.id, infectionControlActor.uid,
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO reprocessing_domain_settings
         (tenant_id, domain, reactive_patient_rule, unknown_serology_rule, isolation_enforcement)
       VALUES ($1::uuid, 'dialysis', 'quarantine', 'warn', 'warn')`, tenantId,
    );
    return { patientId: patient.id, today, protocol, scope };
  });

  return {
    tenantId, patientUid, actor, infectionControlActor, manufacturer, modelName,
    ...fixture,
    async schedule(body = {}) {
      const { scheduleSession } = await import('../../services/clinical/dialysisService.js');
      const session = await scheduleSession({
        tenantId, dialysis_patient_id: fixture.patientId, session_date: fixture.today,
        actor, conducted_by: actor.uid, ...body,
      });
      return session;
    },
    async capture(sessionId, body = {}, operation) {
      const { captureDialyser } = await import('../../services/clinical/dialysisDeviceLifecycleService.js');
      return captureDialyser({
        tenantId, sessionId, actor, operation,
        body: {
          manufacturer_serial: body.device_tag == null ? `PLAN4-${randomUUID()}` : undefined,
          manufacturer,
          model_name: modelName, baseline_tcv_ml: 100, ...body,
        },
      });
    },
    async start(sessionId, body = {}) {
      const { startSession } = await import('../../services/clinical/dialysisService.js');
      return startSession({ tenantId, id: sessionId, actor, ...body });
    },
    async complete(sessionId, body = {}) {
      const { completeSession } = await import('../../services/clinical/dialysisService.js');
      return completeSession({
        tenantId, id: sessionId, completed_by: actor.uid, actorRole: actor.role, actor, ...body,
      });
    },
    async record(sessionId, body = {}, operation) {
      const { recordReuseRegister } = await import('../../services/clinical/dialysisService.js');
      return recordReuseRegister({
        tenantId, session_id: sessionId, processed_by: actor.uid, actor, operation,
        status: 'in_use', integrity_test_result: 'pass', measured_tcv_ml: 95,
        reprocessing_agent: 'peracetic_acid', disinfectant_concentration_pct: 0.3,
        disinfectant_contact_minutes: 12, residual_test_result: 'negative', ...body,
      });
    },
    async lifecycle(sessionId) {
      return setTenantTx(tenantId, async (tx) => {
        const sessions = await tx.$queryRawUnsafe(
          `SELECT id, status, actual_start_at, actual_end_at, early_termination,
                  early_termination_reason, reuse_count
             FROM dialysis_sessions WHERE tenant_id = $1::uuid AND id = $2::int`,
          tenantId, sessionId,
        );
        const usages = await tx.$queryRawUnsafe(
          `SELECT id, device_id, returned_at, reuse_cycle, post_use_processing_event_id,
                  pre_use_residual_test, capture_provenance
             FROM reprocessable_device_usages
            WHERE tenant_id = $1::uuid AND dialysis_session_id = $2::int ORDER BY id`,
          tenantId, sessionId,
        );
        const devices = await tx.$queryRawUnsafe(
          `SELECT id, status, current_usage_id, version, cycle_count, residual_test_pending,
                  last_processing_event_id, exposure_flag
             FROM reprocessable_devices
            WHERE tenant_id = $1::uuid AND id IN (
              SELECT device_id FROM reprocessable_device_usages
               WHERE tenant_id = $1::uuid AND dialysis_session_id = $2::int) ORDER BY id`,
          tenantId, sessionId,
        );
        const registers = await tx.$queryRawUnsafe(
          `SELECT id, device_id, device_usage_id, reuse_cycle_count, release_status,
                  processing_event_id, measured_tcv_ml, integrity_test_result
             FROM dialyzer_reuse_register
            WHERE tenant_id = $1::uuid AND session_id = $2::int ORDER BY id`,
          tenantId, sessionId,
        );
        expect(sessions).toHaveLength(1);
        return { session: sessions[0], usages, devices, registers };
      });
    },
    async cleanup() {
      await setTenantTx(tenantId, async (tx) => {
        // Only this fixture's rows are removed; committed append-only evidence needs
        // the existing deep-test teardown privilege, never a production-path bypass.
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$queryRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
        expect(CLEANUP_STATEMENTS).toHaveLength(32);
        for (const sql of CLEANUP_STATEMENTS) await tx.$executeRawUnsafe(sql, tenantId);
      }, { timeout: 30000 });
    },
  };
}

export { prisma, setTenantTx };
