import { createHash, randomUUID } from 'node:crypto';

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const {
  syncTrialsFromPublicRegistry,
} = await import('../services/ai/trialCatalogSyncService.js');
const {
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerExternalRecoveryOffset,
} = await import('../services/integrations/externalInterfaceRecoveryService.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const PROVIDER_REVISION = '2026-08-04T04:30:00Z';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function study(nctId, title, revision = '2026-08-01') {
  return {
    protocolSection: {
      identificationModule: { nctId, officialTitle: title },
      statusModule: {
        overallStatus: 'RECRUITING',
        lastUpdatePostDateStruct: { date: revision, type: 'ACTUAL' },
      },
      descriptionModule: { briefSummary: `${title} summary` },
      eligibilityModule: {
        eligibilityCriteria: 'Adults with stable disease',
        minimumAge: '18 Years',
        maximumAge: '70 Years',
        sex: 'ALL',
      },
      conditionsModule: { conditions: ['Chronic kidney disease'] },
      contactsLocationsModule: { locations: [{ country: 'India' }] },
      designModule: { phases: ['PHASE2'] },
    },
  };
}

describeIfDb('C6.1-G I23 ClinicalTrials.gov page recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I23 trial recovery tenant')`,
      TENANT_ID,
      `i23-trials-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $4::text,
          'I23 owner', 'ADMIN', true, 'active', NOW())`,
      ACTOR_UID,
      TENANT_ID,
      `93${SUFFIX.slice(0, 10)}`,
      `i23-owner-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('persists every continuation and atomically completes two provider pages', async () => {
    const calls = [];
    const pageOne = {
      studies: [
        study(`NCT${SUFFIX.slice(0, 8)}`, 'I23 page one A'),
        study(`NCT${SUFFIX.slice(1, 9)}`, 'I23 page one B'),
      ],
      nextPageToken: `next-${SUFFIX}`,
    };
    const pageTwo = {
      studies: [study(`NCT${SUFFIX.slice(2, 10)}`, 'I23 page two C')],
    };
    const fetchImpl = async url => {
      calls.push(String(url));
      if (String(url).endsWith('/version')) {
        return response({ version: '2.0.1', dataTimestamp: PROVIDER_REVISION });
      }
      const parsed = new URL(url);
      return parsed.searchParams.get('pageToken') === `next-${SUFFIX}`
        ? response(pageTwo)
        : response(pageOne);
    };

    const result = await syncTrialsFromPublicRegistry({
      tenantId: TENANT_ID,
      conditions: [' Chronic  Kidney Disease '],
      location: ' INDIA ',
      maxResults: 3,
      requestedBy: ACTOR_UID,
      fetchImpl,
    });
    expect(result).toMatchObject({
      status: 'completed',
      provider_revision: PROVIDER_REVISION,
      fetched_count: 3,
      upserted_count: 3,
      completed_pages: 2,
      failed_pages: 0,
    });
    expect(result.run_ids).toHaveLength(2);
    expect(calls.some(url => new URL(url).searchParams.get('pageToken') === `next-${SUFFIX}`))
      .toBe(true);

    const pages = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT id, source_partition, sync_session_id::text, provider_page_number,
              provider_page_token, provider_next_page_token,
              provider_revision, provider_page_sha256::text,
              provider_page_complete, status, fetched_count, upserted_count
         FROM clinical_ai_trial_sync_runs
        WHERE tenant_id = $1::uuid AND id = ANY($2::integer[])
        ORDER BY provider_page_number`,
      TENANT_ID,
      result.run_ids,
    ));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      provider_page_number: 1,
      provider_page_token: 'origin',
      provider_next_page_token: `next-${SUFFIX}`,
      provider_revision: PROVIDER_REVISION,
      provider_page_complete: true,
      status: 'completed',
    });
    expect(pages[1]).toMatchObject({
      source_partition: pages[0].source_partition,
      sync_session_id: pages[0].sync_session_id,
      provider_page_number: 2,
      provider_page_token: `next-${SUFFIX}`,
      provider_next_page_token: null,
      provider_revision: PROVIDER_REVISION,
      provider_page_complete: true,
      status: 'completed',
    });

    const catalog = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT nct_id, title, provider_revision,
              source_payload_sha256::text, source_sync_run_id,
              last_refreshed::text
         FROM clinical_trials_catalog
        WHERE tenant_id = $1::uuid
          AND source_sync_run_id = ANY($2::integer[])
        ORDER BY nct_id`,
      TENANT_ID,
      result.run_ids,
    ));
    expect(catalog).toHaveLength(3);
    expect(catalog.every(row => row.provider_revision === '2026-08-01')).toBe(true);
    expect(catalog.every(row => /^[0-9a-f]{64}$/.test(row.source_payload_sha256))).toBe(true);
  }, 60_000);

  test('rolls back a conflicting page, marks the run failed, and binds only pending review evidence', async () => {
    const nctId = `NCT${SUFFIX.slice(0, 8)}`;
    const conflictingPage = {
      studies: [study(nctId, 'I23 changed bytes at the same provider revision')],
    };
    const rawProviderPage = JSON.stringify(conflictingPage);
    const fetchImpl = async url => String(url).endsWith('/version')
      ? response({ version: '2.0.1', dataTimestamp: PROVIDER_REVISION })
      : response(conflictingPage);

    const before = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT title FROM clinical_trials_catalog
        WHERE tenant_id = $1::uuid AND nct_id = $2::text`,
      TENANT_ID,
      nctId,
    ));
    const result = await syncTrialsFromPublicRegistry({
      tenantId: TENANT_ID,
      conditions: ['chronic kidney disease'],
      location: 'india',
      maxResults: 1,
      requestedBy: ACTOR_UID,
      fetchImpl,
    });
    expect(result).toMatchObject({
      status: 'failed',
      completed_pages: 0,
      failed_pages: 1,
      upserted_count: 0,
    });
    expect(result.error_message).toMatch(/different payload evidence/);
    const failedRunId = result.run_ids[0];
    const failed = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT id, source_partition, sync_session_id::text,
              provider_page_number, provider_page_token,
              provider_page_token_sha256::text, provider_next_page_token,
              provider_revision, provider_page_sha256::text,
              provider_page_complete, status, started_at::text
         FROM clinical_ai_trial_sync_runs
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID,
      failedRunId,
    ));
    expect(failed[0]).toMatchObject({
      provider_page_token: 'origin',
      provider_revision: PROVIDER_REVISION,
      provider_page_sha256: sha256(rawProviderPage),
      provider_page_complete: false,
      status: 'failed',
    });
    const after = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT title FROM clinical_trials_catalog
        WHERE tenant_id = $1::uuid AND nct_id = $2::text`,
      TENANT_ID,
      nctId,
    ));
    expect(after).toEqual(before);

    const predecessorPosition = (BigInt(failedRunId) - 1n).toString();
    const predecessorToken = `i23-predecessor-${predecessorPosition}`;
    const sourceToken = `i23-page:${failed[0].provider_page_token_sha256}:${failed[0].provider_page_sha256}`;
    const duplicateKey = `i23:${failedRunId}:${failed[0].provider_page_token_sha256}:${failed[0].provider_page_sha256}`;
    const offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_ID,
      interfaceFamily: 'I23',
      sourcePartition: failed[0].source_partition,
      initialPosition: predecessorPosition,
      initialToken: predecessorToken,
      retainedFromPosition: predecessorPosition,
      retainedFromToken: predecessorToken,
      policyVersion: 'i23-owner-v1',
      policySignature: `i23-${SUFFIX}`,
      retentionPolicy: 'clinical-trial-page-2555d',
      retentionUntil: '2033-08-03T00:00:00.000Z',
    });
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I23',
      resumeCutoffPosition: String(failedRunId),
      resumeCutoffToken: sourceToken,
    });

    const occurredAt = new Date(failed[0].started_at).toISOString();
    const recoveryPayload = JSON.stringify({
      schema: 'vhhealth.i23.clinical-trial-page-owner-reconciliation/v1',
      sync_run_id: failedRunId,
      source_partition: failed[0].source_partition,
      provider_revision: PROVIDER_REVISION,
      provider_page_token: failed[0].provider_page_token,
      provider_page_sha256: failed[0].provider_page_sha256,
      provider_page: rawProviderPage,
      occurred_at: occurredAt,
    });
    const operation = {
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I23',
      sourcePartition: failed[0].source_partition,
      generation: 1,
      sourcePosition: String(failedRunId),
      sourceToken,
      predecessorToken,
      duplicateKey,
      occurredAt,
      command: {
        raw_payload: recoveryPayload,
        payload_sha256: sha256(recoveryPayload),
        actor_uid: ACTOR_UID,
        owner_reason: 'Owner-directed ClinicalTrials.gov page reconciliation',
        evidence: { owner_reviewed: true, source_export: 'synthetic_i23_fixture' },
      },
    };
    await enqueueExternalRecoveryItem(operation);
    const outcome = await processNextItemTx(operation);
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i23_trial_page_pending_owner_reconciliation',
      receipt_id: String(failedRunId),
      cursor: {
        high_water_position: predecessorPosition,
        high_water_token: predecessorToken,
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    const held = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT run.status, run.provider_page_complete, run.effect_disposition,
              inbox.status AS inbox_status, task.status AS task_status,
              task.workflow_sla_instance_id
         FROM clinical_ai_trial_sync_runs AS run
         JOIN pathway_projector_inbox AS inbox
           ON inbox.tenant_id = run.tenant_id
          AND inbox.inbox_id = run.recovery_inbox_id
         JOIN tasks AS task
           ON task.tenant_id = inbox.tenant_id
          AND task.id = inbox.pending_task_id
        WHERE run.tenant_id = $1::uuid AND run.id = $2::integer`,
      TENANT_ID,
      failedRunId,
    ));
    expect(held[0]).toEqual({
      status: 'failed',
      provider_page_complete: false,
      effect_disposition: 'late_pending_only',
      inbox_status: 'handled',
      task_status: 'open',
      workflow_sla_instance_id: null,
    });
  }, 60_000);

  test('reports provider fetch failure as failed and never completed', async () => {
    const fetchImpl = async url => String(url).endsWith('/version')
      ? response({ version: '2.0.1', dataTimestamp: PROVIDER_REVISION })
      : response({ message: 'unavailable' }, { ok: false, status: 503 });
    const result = await syncTrialsFromPublicRegistry({
      tenantId: TENANT_ID,
      conditions: ['rare fetch failure condition'],
      location: 'india',
      maxResults: 1,
      requestedBy: ACTOR_UID,
      fetchImpl,
    });
    expect(result).toMatchObject({
      status: 'failed',
      completed_pages: 0,
      failed_pages: 1,
      fetched_count: 0,
      upserted_count: 0,
    });
    expect(result.error_message).toContain('clinicaltrials_gov_status_503');
  });

  test('rejects a successful HTTP response that is not a complete studies page', async () => {
    const fetchImpl = async url => String(url).endsWith('/version')
      ? response({ version: '2.0.1', dataTimestamp: PROVIDER_REVISION })
      : response({ nextPageToken: 'unproven-continuation' });
    const result = await syncTrialsFromPublicRegistry({
      tenantId: TENANT_ID,
      conditions: ['invalid provider page condition'],
      location: 'india',
      maxResults: 1,
      requestedBy: ACTOR_UID,
      fetchImpl,
    });
    expect(result).toMatchObject({
      status: 'failed',
      completed_pages: 0,
      failed_pages: 1,
      fetched_count: 0,
      upserted_count: 0,
    });
    expect(result.error_message).toContain('clinicaltrials_gov_invalid_studies_page');
  });
});
