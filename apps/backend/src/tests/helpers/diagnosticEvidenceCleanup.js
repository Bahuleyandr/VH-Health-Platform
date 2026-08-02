// Teardown helper for the append-only diagnostic evidence added by migration 589.
//
// Signing off a lab panel (`signOffResults`) or recording an investigation
// result (`PUT /investigations/:id/results`) writes a
// `diagnostic_result_generations` row plus its generation items. All three
// diagnostic evidence tables are guarded by a BEFORE UPDATE OR DELETE trigger
// that raises `23514 '<table> is append-only'`, so a suite cannot clean up
// after itself with a plain DELETE.
//
// Stranded rows then pin the fixtures through several FK edges — the
// investigation (fk_diagnostic_generation_investigation), the lab sign-off
// (fk_diagnostic_generation_lab_signoff) and the fixture users
// (fk_diagnostic_generation_patient / _signer / _owner). Depending on whether
// the suite swallows its teardown errors, that either fails the NEXT run
// outright or silently leaves the whole rest of the teardown undone.
//
// Suites run only against a disposable test database, so this drops the
// evidence inside one transaction with user and constraint triggers disabled —
// the same mechanism `lab-critical-alert-ack-atomicity.deep.test.js` uses for
// migration 581's immutable alert evidence. Production cleanup paths are
// untouched.
//
// All three tables carry (tenant_id, patient_uid), so one scope covers the
// parent and both children without leaving orphaned child rows.

// Children first, then the parent they reference.
const EVIDENCE_TABLES = [
  'diagnostic_result_actions',
  'diagnostic_result_generation_items',
  'diagnostic_result_generations',
];

/**
 * Drop every diagnostic-evidence row for the given tenant + patient UIDs.
 *
 * Call it from `beforeAll` as well as `afterAll`: the `afterAll` call keeps a
 * run from poisoning the next one, and the `beforeAll` call lets a database
 * that is already poisoned heal itself instead of staying wedged.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tenantId
 * @param {string[]} patientUids — fixture UIDs; nullish entries are ignored.
 */
export async function purgeDiagnosticEvidence(prisma, tenantId, patientUids) {
  const uids = [...new Set((patientUids || []).filter(Boolean))];
  if (uids.length === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of EVIDENCE_TABLES) {
      // Table names come from the fixed list above, never from a caller.
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table}
          WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[])`,
        tenantId,
        uids,
      );
    }
  });
}

export default { purgeDiagnosticEvidence };
