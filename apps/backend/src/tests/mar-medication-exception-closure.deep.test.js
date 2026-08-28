import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import {
  acknowledgeTask,
  reassignTask,
} from '../services/workflow/taskService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('MAR medication exception closed loop', () => {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const nurseUid = randomUUID();
  const doctorUid = randomUUID();
  const secondDoctorUid = randomUUID();
  const adminUid = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  let patientId;
  let nurseId;
  let doctorId;
  let secondDoctorId;
  let clinicalOrderId;

  function client(role, uid, id) {
    const token = generateTestToken(role, {
      uid,
      id,
      tenant_id: tenantId,
      deviceType: 'desktop',
    });
    return {
      get: (path) => request(app)
        .get(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`),
      post: (path, idempotencyKey) => request(app)
        .post(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey),
      patch: (path) => request(app)
        .patch(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`),
    };
  }

  async function createAdministration(label) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route,
          scheduled_time, status, clinical_order_id, supply_quantity_per_dose)
       VALUES ($1::uuid, $2::uuid, $3::text, '5 mg', 'oral',
               NOW(), 'scheduled', $4::integer, 1)
       RETURNING id`,
      tenantId,
      patientUid,
      `MED03 exception ${label} ${run}`,
      clinicalOrderId,
    );
    return Number(rows[0].id);
  }

  async function attemptDirectOpenException({
    administrationId,
    alignAdministration,
    raisedActorRole = 'NURSING_STAFF',
  }) {
    return prisma.$transaction(async (tx) => {
      const occurrenceRows = alignAdministration
        ? await tx.$queryRawUnsafe(
          `UPDATE medication_administrations
              SET status = 'missed',
                  missed_by = $3::uuid,
                  missed_at = clock_timestamp(),
                  notes = 'Direct forged missed-dose obligation'
            WHERE tenant_id = $1::uuid
              AND id = $2::integer
            RETURNING missed_at AS raised_at`,
          tenantId,
          administrationId,
          nurseUid,
        )
        : await tx.$queryRawUnsafe(
          `SELECT clock_timestamp() AS raised_at`,
        );
      const raisedAt = occurrenceRows[0].raised_at;
      const caseRows = await tx.$queryRawUnsafe(
        `SELECT nextval('mar_medication_exception_cases_id_seq')::bigint AS id`,
      );
      const caseId = Number(caseRows[0].id);
      const slaRows = await tx.$queryRawUnsafe(
        `INSERT INTO workflow_sla_instances
           (tenant_id, rule_id, rule_code, patient_uid, encounter_id,
            source_table, source_id, status, priority, started_at, due_at,
            assigned_user_uid, assigned_role_codes, metadata)
         SELECT $1::uuid, policy.id, policy.rule_code, $2::uuid,
                clinical_order.encounter_id,
                'mar_medication_exception_cases', $3::text,
                'active', 'critical', $4::timestamptz,
                $4::timestamptz + INTERVAL '15 minutes', $5::uuid,
                ARRAY['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT',
                      'JUNIOR_DOCTOR', 'RESIDENT']::text[],
                jsonb_build_object(
                  'exception_case_id', $3::bigint,
                  'medication_administration_id', $6::integer,
                  'exception_kind', 'missed'
                )
           FROM workflow_sla_rules policy
           JOIN clinical_orders clinical_order
             ON clinical_order.tenant_id = $1::uuid
            AND clinical_order.id = $7::integer
          WHERE policy.rule_code = 'mar_medication_exception_review'
            AND policy.enabled = TRUE
            AND (policy.tenant_id = $1::uuid OR policy.tenant_id IS NULL)
          ORDER BY (policy.tenant_id = $1::uuid) DESC
          LIMIT 1
         RETURNING id, due_at, encounter_id`,
        tenantId,
        patientUid,
        String(caseId),
        raisedAt,
        doctorUid,
        administrationId,
        clinicalOrderId,
      );
      const sla = slaRows[0];
      const taskRows = await tx.$queryRawUnsafe(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, description, patient_uid,
            related_resource_type, related_resource_id, priority, status,
            assigned_to_uid, workflow_sla_instance_id,
            sla_completion_semantics, stage_occurrence_key, metadata)
         VALUES ($1::uuid, 'review', 'Forged MAR exception',
                 'Direct SQL must not create a typed obligation.', $2::uuid,
                 'mar_medication_exception_cases', $3::text, 'critical', 'open',
                 $4::uuid, $5::uuid, 'domain_evidence', $6::text,
                 jsonb_build_object(
                   'task_contract', 'mar_medication_exception_v1',
                   'exception_case_id', $3::bigint,
                   'medication_administration_id', $7::integer,
                   'exception_kind', 'missed',
                   'assignment_origin', 'source_prescriber',
                   'canonical_encounter_id', $8::text
                 ))
         RETURNING id`,
        tenantId,
        patientUid,
        String(caseId),
        doctorUid,
        sla.id,
        `mar-medication-exception:${caseId}`,
        administrationId,
        String(sla.encounter_id),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mar_medication_exception_cases
           (id, tenant_id, medication_administration_id, clinical_order_id,
            patient_uid, exception_kind, status, reason, raised_by, raised_at,
            assigned_prescriber_uid, task_id, workflow_sla_instance_id,
            notification_coverage_status)
         VALUES ($1::bigint, $2::uuid, $3::integer, $4::integer, $5::uuid,
                 'missed', 'open', 'Direct forged missed-dose obligation',
                 $6::uuid, $7::timestamptz, $8::uuid, $9::integer, $10::uuid,
                 'coverage_gap')`,
        caseId,
        tenantId,
        administrationId,
        clinicalOrderId,
        patientUid,
        nurseUid,
        raisedAt,
        doctorUid,
        taskRows[0].id,
        sla.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mar_medication_exception_events
           (tenant_id, exception_case_id, medication_administration_id,
            event_type, actor_uid, actor_role, reason, command_key,
            request_fingerprint, occurred_at, payload)
         VALUES ($1::uuid, $2::bigint, $3::integer, 'raised', $4::uuid,
                 $5::text, 'Direct forged missed-dose obligation', $6::text,
                 $7::char(64), $8::timestamptz, '{}'::jsonb)`,
        tenantId,
        caseId,
        administrationId,
        nurseUid,
        raisedActorRole,
        `direct-forged-raised-${caseId}`,
        'f'.repeat(64),
        raisedAt,
      );
    });
  }

  async function attemptForgedTerminalResolution({
    caseId,
    actorUid,
    actorRole,
    deactivateActor = false,
  }) {
    return prisma.$transaction(async (tx) => {
      if (deactivateActor) {
        await tx.$executeRawUnsafe(
          `UPDATE users
              SET is_active = FALSE,
                  status = 'inactive',
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND uid = $2::uuid`,
          tenantId,
          actorUid,
        );
      }
      const eventRows = await tx.$queryRawUnsafe(
        `INSERT INTO mar_medication_exception_events
           (tenant_id, exception_case_id, medication_administration_id,
            event_type, disposition, actor_uid, actor_role, reason,
            command_key, request_fingerprint, payload)
         SELECT exception_case.tenant_id, exception_case.id,
                exception_case.medication_administration_id, 'resolved',
                'reviewed_no_replacement', $3::uuid, $4::text,
                'Forged terminal disposition must fail', $5::text,
                $6::char(64), '{}'::jsonb
           FROM mar_medication_exception_cases exception_case
          WHERE exception_case.tenant_id = $1::uuid
            AND exception_case.id = $2::bigint
         RETURNING id, occurred_at`,
        tenantId,
        caseId,
        actorUid,
        actorRole,
        `forged-terminal-${caseId}-${actorUid}`,
        'e'.repeat(64),
      );
      const event = eventRows[0];
      await tx.$executeRawUnsafe(
        `UPDATE tasks task
            SET status = 'completed',
                completed_at = $3::timestamptz,
                updated_at = $3::timestamptz
           FROM mar_medication_exception_cases exception_case
          WHERE exception_case.tenant_id = $1::uuid
            AND exception_case.id = $2::bigint
            AND task.tenant_id = exception_case.tenant_id
            AND task.id = exception_case.task_id`,
        tenantId,
        caseId,
        event.occurred_at,
      );
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances sla
            SET status = 'completed',
                completed_at = $4::timestamptz,
                metadata = COALESCE(sla.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'completed_via', 'domain_evidence',
                       'completed_by_task', exception_case.task_id,
                       'completed_by', $3::text,
                       'completion_evidence', jsonb_build_object(
                         'kind', 'mar_medication_exception_resolution',
                         'resource_type', 'mar_medication_exception_event',
                         'resource_id', $5::text,
                         'occurred_at', $4::timestamptz,
                         'recorded_at', $4::timestamptz,
                         'disposition', 'reviewed_no_replacement',
                         'actor_uid', $3::text
                       )
                     ),
                updated_at = $4::timestamptz
           FROM mar_medication_exception_cases exception_case
          WHERE exception_case.tenant_id = $1::uuid
            AND exception_case.id = $2::bigint
            AND sla.tenant_id = exception_case.tenant_id
            AND sla.id = exception_case.workflow_sla_instance_id`,
        tenantId,
        caseId,
        actorUid,
        event.occurred_at,
        String(event.id),
      );
      await tx.$executeRawUnsafe(
        `UPDATE mar_medication_exception_cases
            SET status = 'resolved',
                resolution_kind = 'reviewed_no_replacement',
                resolution_event_id = $3::bigint,
                resolved_by = $4::uuid,
                resolved_at = $5::timestamptz
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        caseId,
        event.id,
        actorUid,
        event.occurred_at,
      );
    });
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MED-03 exception closure', 'IN',
               'active', NOW(), NOW())`,
      tenantId,
      `med03-exception-${run}`,
    );
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (tenant_id, uid, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $5::text, 'MED03 exception patient',
          'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $3::uuid, $6::text, 'MED03 exception nurse',
          'NURSING_STAFF', TRUE, 'active', NOW()),
         ($1::uuid, $4::uuid, $7::text, 'MED03 exception prescriber',
          'DOCTOR', TRUE, 'active', NOW()),
         ($1::uuid, $8::uuid, $9::text, 'MED03 fallback prescriber',
          'DOCTOR', FALSE, 'inactive', NOW()),
         ($1::uuid, $10::uuid, $11::text, 'MED03 exception administrator',
          'ADMIN', TRUE, 'active', NOW())
       RETURNING id, uid::text`,
      tenantId,
      patientUid,
      nurseUid,
      doctorUid,
      `+91970${String(Date.now()).slice(-7)}`,
      `+91971${String(Date.now()).slice(-7)}`,
      `+91972${String(Date.now()).slice(-7)}`,
      secondDoctorUid,
      `+91973${String(Date.now()).slice(-7)}`,
      adminUid,
      `+91974${String(Date.now()).slice(-7)}`,
    );
    patientId = Number(users.find((row) => row.uid === patientUid).id);
    nurseId = Number(users.find((row) => row.uid === nurseUid).id);
    doctorId = Number(users.find((row) => row.uid === doctorUid).id);
    secondDoctorId = Number(users.find((row) => row.uid === secondDoctorUid).id);
    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, admitted_at, ward, bed_number,
          created_by, attending_doctor, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), 'MED03 Ward', $3::text,
               $4::uuid, $5::uuid, NOW(), NOW())
       RETURNING encounter_id`,
      tenantId,
      patientUid,
      `MED03-${run}`,
      nurseUid,
      doctorUid,
    );
    const orderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, encounter_id, patient_uid, order_type,
          status, ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication',
               'ordered', $5::uuid,
               '{"medication_name":"MED03 exception medicine","dose":"5 mg","route":"oral"}'::jsonb,
               'oral', NOW())
       RETURNING id`,
      tenantId,
      `MED03-EXCEPTION-${run}`,
      admissions[0].encounter_id,
      patientUid,
      doctorUid,
    );
    clinicalOrderId = Number(orderRows[0].id);
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, TRUE),
                set_config('app.current_user_role', 'SUPER_ADMIN', TRUE),
                set_config('app.current_user_uid', $2::text, TRUE)`,
        tenantId,
        doctorUid,
      );
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DO $cleanup$
         DECLARE
           relation_record RECORD;
         BEGIN
           FOR relation_record IN
             SELECT table_info.table_name
               FROM information_schema.tables table_info
               JOIN information_schema.columns column_info
                 ON column_info.table_schema = table_info.table_schema
                AND column_info.table_name = table_info.table_name
              WHERE table_info.table_schema = 'public'
                AND table_info.table_type = 'BASE TABLE'
                AND column_info.column_name = 'tenant_id'
              ORDER BY table_info.table_name
           LOOP
             EXECUTE format(
               'DELETE FROM public.%I WHERE tenant_id::text = $1',
               relation_record.table_name
             ) USING current_setting('app.current_tenant_id');
           END LOOP;
         END
         $cleanup$`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
    }, { timeout: 30_000 });
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  test('direct typed forgeries require the exact dose state and raised-event actor', async () => {
    const scheduledAdministrationId = await createAdministration('forged-scheduled');
    await expect(attemptDirectOpenException({
      administrationId: scheduledAdministrationId,
      alignAdministration: false,
    })).rejects.toThrow(/MAR medication exception/i);

    const wrongActorAdministrationId = await createAdministration('forged-raised-actor');
    await expect(attemptDirectOpenException({
      administrationId: wrongActorAdministrationId,
      alignAdministration: true,
      raisedActorRole: 'DOCTOR',
    })).rejects.toThrow(/MAR medication exception/i);

    const cases = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM mar_medication_exception_cases
        WHERE tenant_id = $1::uuid
          AND medication_administration_id IN ($2::integer, $3::integer)`,
      tenantId,
      scheduledAdministrationId,
      wrongActorAdministrationId,
    );
    expect(cases[0].count).toBe(0);
  });

  test('held dose materializes an assigned typed task, 15-minute SLA, notification, and exact release receipt', async () => {
    const administrationId = await createAdministration('held');
    const nurse = client('NURSING_STAFF', nurseUid, nurseId);
    const doctor = client('DOCTOR', doctorUid, doctorId);
    const holdKey = `med03-hold-${run}`;
    const holdBody = { reason: 'Observed hypotension; hold pending prescriber review' };

    const held = await nurse
      .post(`/api/v1/clinical/mar/${administrationId}/hold`, holdKey)
      .send(holdBody);
    expect(held.status).toBe(200);
    expect(held.body.data).toMatchObject({ id: administrationId, status: 'held' });

    const obligations = await prisma.$queryRawUnsafe(
      `SELECT exception_case.id,
              exception_case.status,
              exception_case.exception_kind,
              exception_case.raised_by::text,
              exception_case.assigned_prescriber_uid::text,
              exception_case.notification_coverage_status,
              task.id AS task_id,
              task.status AS task_status,
              task.priority,
              task.sla_completion_semantics,
              task.metadata,
              sla.id AS sla_id,
              sla.status AS sla_status,
              EXTRACT(EPOCH FROM (sla.due_at - sla.started_at)) / 60 AS target_minutes,
              outbox.recipient_id,
              outbox.payload AS notification_payload
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         LEFT JOIN notification_outbox outbox
           ON outbox.tenant_id = exception_case.tenant_id
          AND outbox.source_event_key LIKE
                'mar-exception:' || exception_case.id::text || ':raised:%'
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.medication_administration_id = $2::integer`,
      tenantId,
      administrationId,
    );
    expect(obligations).toHaveLength(1);
    const obligation = obligations[0];
    expect(obligation).toMatchObject({
      status: 'open',
      exception_kind: 'held',
      raised_by: nurseUid,
      assigned_prescriber_uid: doctorUid,
      notification_coverage_status: 'notified',
      task_status: 'open',
      priority: 'critical',
      sla_completion_semantics: 'domain_evidence',
      sla_status: 'active',
      recipient_id: String(doctorId),
    });
    expect(Number(obligation.target_minutes)).toBe(15);
    expect(obligation.metadata).toMatchObject({
      task_contract: 'mar_medication_exception_v1',
      medication_administration_id: administrationId,
      exception_kind: 'held',
    });
    expect(obligation.notification_payload).toMatchObject({
      kind: 'mar_medication_exception',
      exception_case_id: String(obligation.id),
      medication_administration_id: administrationId,
      deep_link: `/mar/due?exception_id=${Number(obligation.id)}`,
    });

    const nurseQueue = await nurse.get('/api/v1/clinical/mar/exceptions');
    expect(nurseQueue.status).toBe(403);
    const doctorQueue = await doctor.get('/api/v1/clinical/mar/exceptions');
    expect(doctorQueue.status).toBe(200);
    expect(doctorQueue.body.data).toEqual([
      expect.objectContaining({
        id: administrationId,
        exception_case_id: String(obligation.id),
        exception_kind: 'held',
      }),
    ]);

    const releaseKey = `med03-release-${run}`;
    const releaseBody = { reason: 'Prescriber reviewed observations and released the scheduled dose' };
    const released = await doctor
      .post(`/api/v1/clinical/mar/${administrationId}/release-hold`, releaseKey)
      .send(releaseBody);
    expect(released.status).toBe(200);
    expect(released.body.data).toMatchObject({ id: administrationId, status: 'scheduled' });
    const replay = await doctor
      .post(`/api/v1/clinical/mar/${administrationId}/release-hold`, releaseKey)
      .send(releaseBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(released.body);

    const terminal = (await prisma.$queryRawUnsafe(
      `SELECT exception_case.status,
              exception_case.resolution_kind,
              task.status AS task_status,
              sla.status AS sla_status,
              sla.completed_at,
              sla.metadata->'completion_evidence' AS completion_evidence,
              resolution.event_type,
              resolution.disposition,
              resolution.actor_uid::text
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         JOIN mar_medication_exception_events resolution
           ON resolution.tenant_id = exception_case.tenant_id
          AND resolution.id = exception_case.resolution_event_id
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.id = $2::bigint`,
      tenantId,
      Number(obligation.id),
    ))[0];
    expect(terminal).toMatchObject({
      status: 'resolved',
      resolution_kind: 'hold_released',
      task_status: 'completed',
      sla_status: 'completed',
      event_type: 'resolved',
      disposition: 'hold_released',
      actor_uid: doctorUid,
    });
    expect(terminal.completed_at).not.toBeNull();
    expect(terminal.completion_evidence).toMatchObject({
      kind: 'mar_medication_exception_resolution',
      resource_type: 'mar_medication_exception_event',
      disposition: 'hold_released',
    });
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET completed_at = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(obligation.task_id),
    ))).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET completed_at = completed_at - INTERVAL '1 minute'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(obligation.task_id),
    ))).rejects.toThrow(/MAR medication exception/i);
  });

  test('missed-dose review closes only the obligation and never mutates treatment', async () => {
    const administrationId = await createAdministration('missed');
    const nurse = client('NURSING_STAFF', nurseUid, nurseId);
    const doctor = client('DOCTOR', doctorUid, doctorId);
    const missed = await nurse
      .post(`/api/v1/clinical/mar/${administrationId}/miss`, `med03-miss-${run}`)
      .send({ reason: 'Patient unavailable at the scheduled administration time' });
    expect(missed.status).toBe(200);
    expect(missed.body.data).toMatchObject({ id: administrationId, status: 'missed' });

    const caseRows = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM mar_medication_exception_cases
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::integer`,
      tenantId,
      administrationId,
    );
    const caseId = String(caseRows[0].id);
    const dispositionKey = `med03-missed-review-${run}`;
    const dispositionBody = {
      disposition: 'reviewed_no_replacement',
      reason: 'Reviewed clinically; no replacement or treatment change recorded here',
    };
    const resolved = await doctor
      .post(`/api/v1/clinical/mar/exceptions/${caseId}/disposition`, dispositionKey)
      .send(dispositionBody);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({
      exception_case_id: caseId,
      medication_administration_id: administrationId,
      status: 'resolved',
      disposition: 'reviewed_no_replacement',
      replayed: false,
    });
    const replay = await doctor
      .post(`/api/v1/clinical/mar/exceptions/${caseId}/disposition`, dispositionKey)
      .send(dispositionBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(resolved.body);

    const evidence = (await prisma.$queryRawUnsafe(
      `SELECT administration.status AS administration_status,
              clinical_order.status AS order_status,
              exception_case.status AS exception_status,
              exception_case.resolution_kind,
              task.status AS task_status,
              sla.completed_at,
              timeline.payload
         FROM mar_medication_exception_cases exception_case
         JOIN medication_administrations administration
           ON administration.tenant_id = exception_case.tenant_id
          AND administration.id = exception_case.medication_administration_id
         JOIN clinical_orders clinical_order
           ON clinical_order.tenant_id = exception_case.tenant_id
          AND clinical_order.id = exception_case.clinical_order_id
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         JOIN clinical_timeline_events timeline
           ON timeline.tenant_id = exception_case.tenant_id
          AND timeline.source_table = 'medication_administrations'
          AND timeline.source_id = administration.id::text
          AND timeline.event_type = 'mar.exception_reviewed'
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.id = $2::bigint`,
      tenantId,
      caseId,
    ))[0];
    expect(evidence).toMatchObject({
      administration_status: 'missed',
      order_status: 'ordered',
      exception_status: 'resolved',
      resolution_kind: 'reviewed_no_replacement',
      task_status: 'completed',
      payload: expect.objectContaining({
        disposition: 'reviewed_no_replacement',
        treatment_mutated: false,
      }),
    });
    expect(evidence.completed_at).not.toBeNull();
  });

  test('unassigned fallback is claimed once across case, task, and SLA before disposition', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = FALSE,
              status = 'inactive',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid IN ($2::uuid, $3::uuid)`,
      tenantId,
      doctorUid,
      secondDoctorUid,
    );
    const administrationId = await createAdministration('fallback');
    const nurse = client('NURSING_STAFF', nurseUid, nurseId);
    const missed = await nurse
      .post(`/api/v1/clinical/mar/${administrationId}/miss`, `med03-fallback-miss-${run}`)
      .send({ reason: 'Patient was away from the ward at the scheduled time' });
    expect(missed.status).toBe(200);

    const fallback = (await prisma.$queryRawUnsafe(
      `SELECT exception_case.id,
              exception_case.workflow_sla_instance_id,
              exception_case.assigned_prescriber_uid::text,
              exception_case.notification_coverage_status,
              task.id AS task_id,
              task.assigned_to_uid::text AS task_assigned_to_uid,
              task.assigned_to_role,
              sla.assigned_user_uid::text AS sla_assigned_user_uid
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.medication_administration_id = $2::integer`,
      tenantId,
      administrationId,
    ))[0];
    expect(fallback).toMatchObject({
      assigned_prescriber_uid: null,
      notification_coverage_status: 'coverage_gap',
      task_assigned_to_uid: null,
      assigned_to_role: 'DOCTOR',
      sla_assigned_user_uid: null,
    });

    const protectedBefore = (await prisma.$queryRawUnsafe(
      `SELECT exception_case.assigned_prescriber_uid::text,
              task.status AS task_status,
              task.assigned_to_uid::text AS task_assigned_to_uid,
              task.assigned_to_role,
              task.metadata,
              sla.assigned_user_uid::text AS sla_assigned_user_uid,
              sla.assigned_role_codes,
              COUNT(comment.id)::integer AS comment_count
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.id = $2::bigint
        GROUP BY exception_case.assigned_prescriber_uid,
                 task.status,
                 task.assigned_to_uid,
                 task.assigned_to_role,
                 task.metadata,
                 sla.assigned_user_uid,
                 sla.assigned_role_codes`,
      tenantId,
      Number(fallback.id),
    ))[0];
    await expect(reassignTask({
      tenantId,
      id: Number(fallback.task_id),
      assignedToUid: null,
      assignedToRole: null,
    })).rejects.toMatchObject({
      code: 'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED',
    });
    await expect(acknowledgeTask({
      tenantId,
      id: Number(fallback.task_id),
      actorUid: adminUid,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
    })).rejects.toMatchObject({
      code: 'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED',
    });
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET assigned_to_uid = $3::uuid,
                assigned_to_role = NULL
          WHERE tenant_id = $1::uuid
            AND id = $2::integer`,
        tenantId,
        Number(fallback.task_id),
        doctorUid,
      );
    })).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET assigned_user_uid = $3::uuid,
                assigned_role_codes = ARRAY[]::text[]
          WHERE tenant_id = $1::uuid
            AND id = (
              SELECT workflow_sla_instance_id
                FROM mar_medication_exception_cases
               WHERE tenant_id = $1::uuid
                 AND id = $2::bigint
            )`,
        tenantId,
        Number(fallback.id),
        doctorUid,
      );
    })).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE mar_medication_exception_cases
            SET assigned_prescriber_uid = $3::uuid
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        Number(fallback.id),
        doctorUid,
      );
    })).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET patient_uid = $3::uuid
          WHERE tenant_id = $1::uuid
            AND id = $2::integer`,
        tenantId,
        Number(fallback.task_id),
        nurseUid,
      );
    })).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET metadata = jsonb_set(
                  jsonb_set(
                    metadata,
                    '{medication_administration_id}',
                    to_jsonb(($3::integer + 1)::integer)
                  ),
                  '{exception_kind}',
                  '"held"'::jsonb
                )
          WHERE tenant_id = $1::uuid
            AND id = $2::integer`,
        tenantId,
        Number(fallback.task_id),
        administrationId,
      );
    })).rejects.toThrow(/MAR medication exception/i);
    const protectedAfter = (await prisma.$queryRawUnsafe(
      `SELECT exception_case.assigned_prescriber_uid::text,
              task.status AS task_status,
              task.assigned_to_uid::text AS task_assigned_to_uid,
              task.assigned_to_role,
              task.metadata,
              sla.assigned_user_uid::text AS sla_assigned_user_uid,
              sla.assigned_role_codes,
              COUNT(comment.id)::integer AS comment_count
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.id = $2::bigint
        GROUP BY exception_case.assigned_prescriber_uid,
                 task.status,
                 task.assigned_to_uid,
                 task.assigned_to_role,
                 task.metadata,
                 sla.assigned_user_uid,
                 sla.assigned_role_codes`,
      tenantId,
      Number(fallback.id),
    ))[0];
    expect(protectedAfter).toEqual(protectedBefore);

    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = TRUE,
              status = 'active',
              role = CASE WHEN uid = $3::uuid THEN 'DUTY_DOCTOR' ELSE role END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid IN ($2::uuid, $3::uuid)`,
      tenantId,
      doctorUid,
      secondDoctorUid,
    );
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET assigned_to_uid = $3::uuid,
                assigned_to_role = NULL
          WHERE tenant_id = $1::uuid
            AND id = $2::integer`,
        tenantId,
        Number(fallback.task_id),
        doctorUid,
      );
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET assigned_user_uid = $3::uuid,
                assigned_role_codes = ARRAY[]::text[]
          WHERE tenant_id = $1::uuid
            AND id = (
              SELECT workflow_sla_instance_id
                FROM mar_medication_exception_cases
               WHERE tenant_id = $1::uuid
                 AND id = $2::bigint
            )`,
        tenantId,
        Number(fallback.id),
        doctorUid,
      );
      await tx.$executeRawUnsafe(
        `UPDATE mar_medication_exception_cases
            SET assigned_prescriber_uid = $3::uuid
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        Number(fallback.id),
        doctorUid,
      );
    })).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET task_kind = 'general'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(fallback.task_id),
    ))).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET status = 'blocked'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(fallback.task_id),
    ))).rejects.toThrow(/unroutable blocked state/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET priority = 'low'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(fallback.task_id),
    ))).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET priority = 'low'
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      tenantId,
      fallback.workflow_sla_instance_id,
    ))).rejects.toThrow(/MAR medication exception/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET completed_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(fallback.task_id),
    ))).rejects.toThrow(/MAR medication exception/i);
    const firstDoctor = client('DOCTOR', doctorUid, doctorId);
    const secondDoctor = client('DUTY_DOCTOR', secondDoctorUid, secondDoctorId);

    const genericClaim = await firstDoctor
      .post(
        `/api/v1/clinical-inbox/tasks/${Number(fallback.task_id)}/claim`,
        `med03-generic-claim-${run}`,
      )
      .send({});
    expect(genericClaim.status).toBe(409);
    expect(genericClaim.body.code).toBe('MAR_EXCEPTION_TASK_CLAIM_WORKFLOW_REQUIRED');

    const claimKeys = [
      `med03-fallback-claim-a-${run}`,
      `med03-fallback-claim-b-${run}`,
    ];
    const claims = await Promise.all([
      firstDoctor
        .post(`/api/v1/clinical/mar/exceptions/${Number(fallback.id)}/claim`, claimKeys[0])
        .send({}),
      secondDoctor
        .post(`/api/v1/clinical/mar/exceptions/${Number(fallback.id)}/claim`, claimKeys[1])
        .send({}),
    ]);
    expect(claims.map((response) => response.status).sort()).toEqual([200, 403]);
    const winnerIndex = claims.findIndex((response) => response.status === 200);
    const winningDoctor = winnerIndex === 0 ? firstDoctor : secondDoctor;
    const losingDoctor = winnerIndex === 0 ? secondDoctor : firstDoctor;
    const winningUid = winnerIndex === 0 ? doctorUid : secondDoctorUid;
    const winningRole = winnerIndex === 0 ? 'DOCTOR' : 'DUTY_DOCTOR';
    const losingUid = winnerIndex === 0 ? secondDoctorUid : doctorUid;
    const losingRole = winnerIndex === 0 ? 'DUTY_DOCTOR' : 'DOCTOR';
    const winningKey = claimKeys[winnerIndex];
    const claimed = claims[winnerIndex];
    expect(claimed.body.data).toMatchObject({
      exception_case_id: String(fallback.id),
      medication_administration_id: administrationId,
      task_id: Number(fallback.task_id),
      assigned_prescriber_uid: winningUid,
      status: 'open',
      replayed: false,
    });

    const replay = await winningDoctor
      .post(`/api/v1/clinical/mar/exceptions/${Number(fallback.id)}/claim`, winningKey)
      .send({});
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(claimed.body);

    const aligned = (await prisma.$queryRawUnsafe(
      `SELECT exception_case.assigned_prescriber_uid::text,
              task.assigned_to_uid::text AS task_assigned_to_uid,
              task.assigned_to_role,
              task.metadata->>'role_claimed_by' AS role_claimed_by,
              task.metadata->>'role_claimed_actor_role' AS role_claimed_actor_role,
              task.metadata->>'role_claimed_actor_raw_role' AS role_claimed_actor_raw_role,
              sla.assigned_user_uid::text AS sla_assigned_user_uid,
              COUNT(comment.id)::integer AS claim_comment_count
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
          AND comment.metadata ? 'claim_receipt'
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.id = $2::bigint
        GROUP BY exception_case.assigned_prescriber_uid,
                 task.assigned_to_uid,
                 task.assigned_to_role,
                 task.metadata,
                 sla.assigned_user_uid`,
      tenantId,
      Number(fallback.id),
    ))[0];
    expect(aligned).toMatchObject({
      assigned_prescriber_uid: winningUid,
      task_assigned_to_uid: winningUid,
      assigned_to_role: null,
      role_claimed_by: winningUid,
      role_claimed_actor_role: winningRole,
      role_claimed_actor_raw_role: winningRole,
      sla_assigned_user_uid: winningUid,
      claim_comment_count: 1,
    });

    await expect(prisma.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id = $2::integer
          AND metadata ? 'claim_receipt'`,
      tenantId,
      Number(fallback.task_id),
    )).rejects.toThrow(/claim receipts are append-only/i);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = FALSE,
              status = 'inactive',
              is_deleted = TRUE,
              deleted_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      tenantId,
      winningUid,
    )).rejects.toThrow(/assignee must remain an active exact prescriber/i);
    await expect(prisma.$transaction(async (tx) => tx.$executeRawUnsafe(
      `UPDATE tasks
          SET metadata = metadata
                - 'role_claim_receipt'
                - 'role_claimed_by'
                - 'role_claimed_actor_raw_role'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      tenantId,
      Number(fallback.task_id),
    ))).rejects.toThrow(/MAR medication exception/i);
    await expect(attemptForgedTerminalResolution({
      caseId: Number(fallback.id),
      actorUid: losingUid,
      actorRole: losingRole,
    })).rejects.toThrow(/MAR medication exception|exact domain evidence/i);

    const winnerQueue = await winningDoctor.get('/api/v1/clinical/mar/exceptions');
    expect(winnerQueue.status).toBe(200);
    expect(winnerQueue.body.data).toContainEqual(expect.objectContaining({
      id: administrationId,
      exception_case_id: String(fallback.id),
    }));
    const loserQueue = await losingDoctor.get('/api/v1/clinical/mar/exceptions');
    expect(loserQueue.status).toBe(200);
    expect(loserQueue.body.data).not.toContainEqual(expect.objectContaining({
      exception_case_id: String(fallback.id),
    }));

    const dispositionBody = {
      disposition: 'reviewed_no_replacement',
      reason: 'Claiming prescriber reviewed the missed dose without treatment mutation',
    };
    const loserDisposition = await losingDoctor
      .post(
        `/api/v1/clinical/mar/exceptions/${Number(fallback.id)}/disposition`,
        `med03-fallback-loser-disposition-${run}`,
      )
      .send(dispositionBody);
    expect(loserDisposition.status).toBe(403);
    const winnerDisposition = await winningDoctor
      .post(
        `/api/v1/clinical/mar/exceptions/${Number(fallback.id)}/disposition`,
        `med03-fallback-winner-disposition-${run}`,
      )
      .send(dispositionBody);
    expect(winnerDisposition.status).toBe(200);
    expect(winnerDisposition.body.data).toMatchObject({
      exception_case_id: String(fallback.id),
      status: 'resolved',
      disposition: 'reviewed_no_replacement',
    });
  });

  test('all five prescriber tiers see and claim only the canonical MAR coverage queue', async () => {
    const nurse = client('NURSING_STAFF', nurseUid, nurseId);
    const unrelatedRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, description, priority, status,
          assigned_to_role, sla_completion_semantics, metadata)
       VALUES ($1::uuid, 'review', $2::text, 'Unrelated generic doctor work',
               'normal', 'open', 'DOCTOR', 'none', '{}'::jsonb)
       RETURNING id`,
      tenantId,
      `MED03 unrelated doctor queue ${run}`,
    );
    const unrelatedTaskId = Number(unrelatedRows[0].id);
    const prescriberRoles = [
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
    ];

    for (const [index, actorRole] of prescriberRoles.entries()) {
      await prisma.$executeRawUnsafe(
        `UPDATE users
            SET is_active = FALSE,
                status = 'inactive',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND uid = $2::uuid`,
        tenantId,
        doctorUid,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE users
            SET role = $3::text,
                is_active = FALSE,
                status = 'inactive',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND uid = $2::uuid`,
        tenantId,
        secondDoctorUid,
        actorRole,
      );

      const administrationId = await createAdministration(`coverage-${actorRole}`);
      const missed = await nurse
        .post(
          `/api/v1/clinical/mar/${administrationId}/miss`,
          `med03-coverage-${index}-miss-${run}`,
        )
        .send({ reason: `Scheduled dose requires ${actorRole} coverage review` });
      expect(missed.status).toBe(200);
      const coverage = (await prisma.$queryRawUnsafe(
        `SELECT exception_case.id,
                exception_case.task_id,
                exception_case.workflow_sla_instance_id
           FROM mar_medication_exception_cases exception_case
          WHERE exception_case.tenant_id = $1::uuid
            AND exception_case.medication_administration_id = $2::integer`,
        tenantId,
        administrationId,
      ))[0];

      await prisma.$executeRawUnsafe(
        `UPDATE users
            SET is_active = TRUE,
                status = 'active',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND uid = $2::uuid`,
        tenantId,
        secondDoctorUid,
      );
      const prescriber = client(actorRole, secondDoctorUid, secondDoctorId);
      const inbox = await prescriber.get('/api/v1/clinical-inbox/tasks/inbox?limit=200');
      expect(inbox.status).toBe(200);
      expect(inbox.body.data.tasks).toContainEqual(expect.objectContaining({
        id: Number(coverage.task_id),
        assigned_to_uid: null,
        assigned_to_role: 'DOCTOR',
      }));
      if (actorRole !== 'DOCTOR') {
        expect(inbox.body.data.tasks).not.toContainEqual(expect.objectContaining({
          id: unrelatedTaskId,
        }));
      }

      const claim = await prescriber
        .post(
          `/api/v1/clinical/mar/exceptions/${Number(coverage.id)}/claim`,
          `med03-coverage-${index}-claim-${run}`,
        )
        .send({});
      expect(claim.status).toBe(200);
      expect(claim.body.data).toMatchObject({
        exception_case_id: String(coverage.id),
        task_id: Number(coverage.task_id),
        assigned_prescriber_uid: secondDoctorUid,
        replayed: false,
      });
      const aligned = (await prisma.$queryRawUnsafe(
        `SELECT exception_case.assigned_prescriber_uid::text,
                task.assigned_to_uid::text AS task_assigned_to_uid,
                task.assigned_to_role,
                task.metadata->>'role_claimed_from_role' AS claimed_from_role,
                task.metadata->>'role_claimed_actor_role' AS actor_role,
                task.metadata->>'role_claimed_actor_raw_role' AS actor_raw_role,
                sla.assigned_user_uid::text AS sla_assigned_user_uid,
                sla.assigned_role_codes
           FROM mar_medication_exception_cases exception_case
           JOIN tasks task
             ON task.tenant_id = exception_case.tenant_id
            AND task.id = exception_case.task_id
           JOIN workflow_sla_instances sla
             ON sla.tenant_id = exception_case.tenant_id
            AND sla.id = exception_case.workflow_sla_instance_id
          WHERE exception_case.tenant_id = $1::uuid
            AND exception_case.id = $2::bigint`,
        tenantId,
        Number(coverage.id),
      ))[0];
      expect(aligned).toMatchObject({
        assigned_prescriber_uid: secondDoctorUid,
        task_assigned_to_uid: secondDoctorUid,
        assigned_to_role: null,
        claimed_from_role: 'DOCTOR',
        actor_role: actorRole,
        actor_raw_role: actorRole,
        sla_assigned_user_uid: secondDoctorUid,
        assigned_role_codes: [],
      });

      const disposition = await prescriber
        .post(
          `/api/v1/clinical/mar/exceptions/${Number(coverage.id)}/disposition`,
          `med03-coverage-${index}-disposition-${run}`,
        )
        .send({
          disposition: 'reviewed_no_replacement',
          reason: `${actorRole} reviewed the missed dose without treatment mutation`,
        });
      expect(disposition.status).toBe(200);
      await prisma.$executeRawUnsafe(
        `UPDATE users
            SET is_active = FALSE,
                status = 'inactive',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND uid = $2::uuid`,
        tenantId,
        secondDoctorUid,
      );
    }

    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET role = 'DMO',
              is_active = FALSE,
              status = 'inactive',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      tenantId,
      secondDoctorUid,
    );
    const aliasAdministrationId = await createAdministration('coverage-DMO-alias');
    const aliasMissed = await nurse
      .post(
        `/api/v1/clinical/mar/${aliasAdministrationId}/miss`,
        `med03-coverage-alias-miss-${run}`,
      )
      .send({ reason: 'Scheduled dose requires exact prescriber role coverage' });
    expect(aliasMissed.status).toBe(200);
    const aliasCoverage = (await prisma.$queryRawUnsafe(
      `SELECT id, task_id, workflow_sla_instance_id
         FROM mar_medication_exception_cases
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::integer`,
      tenantId,
      aliasAdministrationId,
    ))[0];
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = TRUE,
              status = 'active',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      tenantId,
      secondDoctorUid,
    );
    const aliasDoctor = client('DMO', secondDoctorUid, secondDoctorId);
    const aliasInbox = await aliasDoctor.get('/api/v1/clinical-inbox/tasks/inbox?limit=200');
    expect(aliasInbox.status).toBe(200);
    expect(aliasInbox.body.data.tasks).not.toContainEqual(expect.objectContaining({
      id: Number(aliasCoverage.task_id),
    }));
    const aliasClaim = await aliasDoctor
      .post(
        `/api/v1/clinical/mar/exceptions/${Number(aliasCoverage.id)}/claim`,
        `med03-coverage-alias-claim-${run}`,
      )
      .send({});
    expect(aliasClaim.status).toBe(403);
    expect(aliasClaim.body.code).toBe('TASK_CLAIM_FORBIDDEN');
    const aliasState = (await prisma.$queryRawUnsafe(
      `SELECT exception_case.assigned_prescriber_uid::text,
              task.assigned_to_uid::text AS task_assigned_to_uid,
              task.assigned_to_role,
              sla.assigned_user_uid::text AS sla_assigned_user_uid
         FROM mar_medication_exception_cases exception_case
         JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
        WHERE exception_case.tenant_id = $1::uuid
          AND exception_case.id = $2::bigint`,
      tenantId,
      Number(aliasCoverage.id),
    ))[0];
    expect(aliasState).toEqual({
      assigned_prescriber_uid: null,
      task_assigned_to_uid: null,
      assigned_to_role: 'DOCTOR',
      sla_assigned_user_uid: null,
    });
  }, 60_000);
});
