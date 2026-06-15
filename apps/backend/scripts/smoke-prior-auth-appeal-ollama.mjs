#!/usr/bin/env node
/**
 * smoke-prior-auth-appeal-ollama.mjs
 *
 * Proves that composePriorAuthAppeal produces a REAL AI draft (used_ai=true)
 * when CLINICAL_AI_PROVIDER=ollama is set and gemma2:9b is available at
 * http://localhost:11434.
 *
 * Run from apps/backend:
 *   node scripts/smoke-prior-auth-appeal-ollama.mjs
 *
 * Exit 0 = PASS (used_ai=true, real Ollama draft produced)
 * Exit 1 = FAIL (fell back to template or encountered an error)
 */

// ─── Step 1: Set env BEFORE any service imports ────────────────────────────
process.env.CLINICAL_AI_PROVIDER = 'ollama';
process.env.CLINICAL_AI_BASE_URL = 'http://localhost:11434';
process.env.CLINICAL_AI_MODEL = 'gemma2:9b';
process.env.CLINICAL_AI_TIMEOUT_MS = '120000';

// QA Postgres (mirrors the deep test harness)
const QA_URL = 'postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test';
process.env.DATABASE_URL = QA_URL;
process.env.TEST_DATABASE_URL = QA_URL;

// Disable retry noise for a clean smoke run
process.env.CLINICAL_AI_RETRY_ATTEMPTS = '0';

// ─── Constants (mirror deep test) ──────────────────────────────────────────
const TENANT_ID = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
const PATIENT_UID = 'de000000-dead-4000-beef-000000000313';

// ─── Step 2: Warm the model BEFORE importing any service ───────────────────
async function warmModel(model, baseUrl) {
  process.stdout.write(`[smoke] Warming model ${model} at ${baseUrl} … `);
  try {
    const resp = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'ok', stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.log(`HTTP ${resp.status} (proceeding anyway)`);
    } else {
      console.log('done.');
    }
  } catch (err) {
    console.log(`warn: ${err.message} (proceeding anyway)`);
  }
}

// ─── DB helper (owner-path, mirroring the deep test) ───────────────────────
async function ownerQuery(prisma, text, params = []) {
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

/**
 * Enable the appeal_letter_generator module for this smoke run.
 * Returns { hadTenantOverride, priorGlobalEnabled } so cleanup can
 * restore the DB to exactly the state it found.
 */
async function enableAppealModule(prisma) {
  // Capture whether a tenant override row already exists (so cleanup can
  // delete ours only if we created it).
  const { rows: existingOverride } = await ownerQuery(
    prisma,
    `SELECT enabled FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid AND module_key = 'appeal_letter_generator'`,
    [TENANT_ID],
  );
  const hadTenantOverride = existingOverride.length > 0;

  // Enable at the tenant-override level (for the composePriorAuthAppeal module gate)
  await ownerQuery(
    prisma,
    `INSERT INTO clinical_ai_tenant_modules
       (tenant_id, module_key, enabled, settings, created_at, updated_at)
     VALUES ($1::uuid, 'appeal_letter_generator', true, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = true, updated_at = NOW()`,
    [TENANT_ID],
  );

  // Capture the prior global enabled value so cleanup can restore it exactly.
  const { rows: globalRows } = await ownerQuery(
    prisma,
    `SELECT enabled FROM clinical_ai_modules WHERE module_key = 'appeal_letter_generator'`,
    [],
  );
  const priorGlobalEnabled = globalRows.length > 0 ? Boolean(globalRows[0].enabled) : false;

  // Also enable at the global module level so generateClinicalText (which calls
  // getClinicalAiModule without tenantId inside generateAppealLetter) sees
  // enabled=true and routes to Ollama rather than the template fallback.
  await ownerQuery(
    prisma,
    `UPDATE clinical_ai_modules SET enabled = true, updated_at = NOW() WHERE module_key = 'appeal_letter_generator'`,
    [],
  );

  return { hadTenantOverride, priorGlobalEnabled };
}

async function seedPriorAuth(prisma) {
  const { rows } = await ownerQuery(
    prisma,
    `INSERT INTO clinical_ai_prior_auth_requests
       (tenant_id, patient_uid, payer_name, procedure_code, medical_necessity,
        packet_draft, status, payer_decision_reason, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'TestPayer', 'CPT-99213',
             'Patient requires CPT-99213 outpatient evaluation for newly diagnosed hypertension with end-organ risk. Clinical guidelines support this office visit level for initial workup including BP staging, ECG, basic metabolic panel, and lifestyle counseling.',
             '{"smoke":true}'::jsonb, 'denied', 'Not medically necessary per review — insufficient documentation of clinical need',
             NOW(), NOW())
     RETURNING id`,
    [TENANT_ID, PATIENT_UID],
  );
  return rows[0].id;
}

async function cleanup(prisma, priorAuthIds = [], { hadTenantOverride = false, priorGlobalEnabled = false } = {}) {
  await ownerQuery(prisma, `DELETE FROM clinical_ai_appeal_letters WHERE patient_uid = $1::uuid`, [PATIENT_UID]).catch(() => {});

  if (priorAuthIds.length) {
    await ownerQuery(prisma, `DELETE FROM clinical_ai_appeal_letters WHERE prior_auth_id = ANY($1::int[])`, [priorAuthIds]).catch(() => {});
  }

  await ownerQuery(
    prisma,
    `DELETE FROM clinical_ai_workflow_runs WHERE workflow_key = 'prior_auth_appeal_chain' AND tenant_id = $1::uuid`,
    [TENANT_ID],
  ).catch(() => {});

  await ownerQuery(prisma, `DELETE FROM clinical_ai_generations WHERE patient_uid = $1::uuid`, [PATIENT_UID]).catch(() => {});
  await ownerQuery(prisma, `DELETE FROM clinical_ai_reviews WHERE patient_uid = $1::uuid`, [PATIENT_UID]).catch(() => {});

  if (priorAuthIds.length) {
    await ownerQuery(prisma, `DELETE FROM clinical_ai_prior_auth_requests WHERE id = ANY($1::int[])`, [priorAuthIds]).catch(() => {});
  }

  // Restore tenant override to its pre-test state:
  //   - If we created the row (hadTenantOverride=false), DELETE it — restores the
  //     no-row baseline so 3-layer resolution falls through to global default.
  //   - If the row already existed before us, leave it alone (we only set enabled=true,
  //     which was its pre-existing state given we did ON CONFLICT DO UPDATE).
  if (!hadTenantOverride) {
    await ownerQuery(
      prisma,
      `DELETE FROM clinical_ai_tenant_modules WHERE tenant_id = $1::uuid AND module_key = 'appeal_letter_generator'`,
      [TENANT_ID],
    ).catch(() => {});
  }

  // Restore the global module enabled flag to whatever it was before setup.
  await ownerQuery(
    prisma,
    `UPDATE clinical_ai_modules SET enabled = $1, updated_at = NOW() WHERE module_key = 'appeal_letter_generator'`,
    [priorGlobalEnabled],
  ).catch(() => {});
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const model = process.env.CLINICAL_AI_MODEL;
  const baseUrl = process.env.CLINICAL_AI_BASE_URL;

  // Warm BEFORE imports (services read env at module-load time for config)
  await warmModel(model, baseUrl);

  // ─── Step 3: Dynamic imports AFTER env is set ───────────────────────────
  const { default: prisma } = await import('../src/lib/prisma.js');
  const { composePriorAuthAppeal } = await import('../src/services/ai/priorAuthAppealChainService.js');
  const { _resetDefaultCheckpointStore } = await import('../src/services/ai/workflowCheckpointStore.js');

  let paId;
  let exitCode = 1;
  let moduleState = { hadTenantOverride: false, priorGlobalEnabled: false };

  try {
    // ─── Step 4: Seed ─────────────────────────────────────────────────────
    console.log('[smoke] Enabling appeal_letter_generator module …');
    moduleState = await enableAppealModule(prisma);

    console.log('[smoke] Seeding denied prior-auth request …');
    paId = await seedPriorAuth(prisma);
    console.log(`[smoke] Seeded prior_auth id=${paId}`);

    // ─── Step 5: Run the workflow ─────────────────────────────────────────
    console.log('[smoke] Calling composePriorAuthAppeal … (may take up to 2 min)');
    const result = await composePriorAuthAppeal(paId, { tenantId: TENANT_ID });

    if (result.status !== 'paused' || result.pause_reason !== 'await_appeal_human_disposition') {
      console.error(`[smoke] FAIL: unexpected workflow result: ${JSON.stringify(result)}`);
      exitCode = 1;
    } else {
      // ─── Step 6: Read back generation row ─────────────────────────────
      const { rows: appealRows } = await ownerQuery(
        prisma,
        `SELECT id, generation_id, metadata FROM clinical_ai_appeal_letters WHERE prior_auth_id = $1 LIMIT 1`,
        [paId],
      );

      if (!appealRows.length) {
        console.error('[smoke] FAIL: no appeal letter row found after workflow');
        exitCode = 1;
      } else {
        const appeal = appealRows[0];
        const genId = appeal.generation_id;

        // Read used_ai and provider from the generation row
        let usedAi = false;
        let provider = 'unknown';
        let narrativeSnippet = '';

        if (genId) {
          const { rows: genRows } = await ownerQuery(
            prisma,
            `SELECT used_ai, provider, model, draft FROM clinical_ai_generations WHERE id = $1 LIMIT 1`,
            [genId],
          );
          if (genRows.length) {
            usedAi = Boolean(genRows[0].used_ai);
            provider = genRows[0].provider || 'unknown';
            // Extract narrative snippet from the draft JSON
            try {
              const draft = typeof genRows[0].draft === 'string'
                ? JSON.parse(genRows[0].draft)
                : genRows[0].draft;
              const narrative = draft?.medical_necessity || draft?.cover_letter || '';
              narrativeSnippet = String(narrative).slice(0, 220);
            } catch {
              narrativeSnippet = '(could not parse draft)';
            }
          }
        } else {
          // No generation_id — fall through, used_ai stays false
          narrativeSnippet = '(no generation_id on appeal row)';
        }

        // Also check appeal metadata for used_ai (belt-and-suspenders)
        let metaUsedAi = false;
        let metaProvider = null;
        try {
          const meta = typeof appeal.metadata === 'string'
            ? JSON.parse(appeal.metadata)
            : appeal.metadata;
          metaUsedAi = Boolean(meta?.used_ai);
          metaProvider = meta?.provider || null;
        } catch { /* ignore */ }

        const finalUsedAi = usedAi || metaUsedAi;
        const finalProvider = provider !== 'unknown' ? provider : (metaProvider || 'unknown');

        // ─── Step 7: Print result ───────────────────────────────────────
        if (finalUsedAi) {
          console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`SMOKE PASS: used_ai=true  provider=${finalProvider}  model=${model}`);
          console.log(`narrative snippet: ${narrativeSnippet}`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          exitCode = 0;
        } else {
          console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`SMOKE FAIL: used_ai=false (fell back to template)  provider=${finalProvider}  model=${model}`);
          console.log(`reason: generation_id=${genId ?? 'null'}, metaUsedAi=${metaUsedAi}, usedAi=${usedAi}`);
          if (narrativeSnippet) console.log(`narrative snippet: ${narrativeSnippet}`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          exitCode = 1;
        }
      }
    }
  } catch (err) {
    console.error(`[smoke] FAIL: unhandled error: ${err.message}`);
    console.error(err.stack);
    exitCode = 1;
  } finally {
    // ─── Step 8: Cleanup ──────────────────────────────────────────────────
    if (paId !== undefined) {
      console.log('[smoke] Cleaning up seeded rows …');
      await cleanup(prisma, [paId], moduleState);
    }
    _resetDefaultCheckpointStore();
    await prisma.$disconnect().catch(() => {});
    console.log('[smoke] Cleanup complete.');
  }

  process.exit(exitCode);
}

main();
