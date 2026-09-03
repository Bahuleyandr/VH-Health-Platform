import { readFileSync } from 'node:fs';

const importService = readFileSync(
  new URL('../../services/import/patientDataImport.js', import.meta.url),
  'utf8',
);
const vitalsService = readFileSync(
  new URL('../../services/emr/vitalsChartService.js', import.meta.url),
  'utf8',
);
const verificationService = readFileSync(
  new URL('../../services/emr/deviceVitalsService.js', import.meta.url),
  'utf8',
);
const verificationRoutes = readFileSync(
  new URL('../../routes/emr/deviceVitalsRoutes.js', import.meta.url),
  'utf8',
);

describe('manual clinical-import vitals verification source contract', () => {
  test('manual bundle imports alone opt into the asserted-unverified hold', () => {
    expect(importService).toMatch(
      /importObservationSet\(resources,[\s\S]*requiresClinicalVerification: true/,
    );
    expect(importService).toMatch(
      /importFhirVitalObservation[\s\S]*importObservationSet\(\[fhirObservation\],[\s\S]*tenantId,[\s\S]*beforeFhirVitalWrite/,
    );
    expect(vitalsService).toMatch(
      /clinicalEffectsHeld = normalizedSource === 'fhir' && requireClinicalVerification === true/,
    );
    expect(vitalsService).toMatch(
      /device_verified: normalizedSource === 'device' \|\| clinicalEffectsHeld \? false : null/,
    );
    expect(vitalsService).toMatch(
      /clinicalEffectsHeld[\s\S]*'asserted_unverified'[\s\S]*verification_status: verificationStatus/,
    );
  });

  test('held rows cannot persist or fan out effects before verification', () => {
    expect(vitalsService).toMatch(/if \(!clinicalEffectsHeld\) \{[\s\S]*persistNews2/);
    expect(vitalsService).toMatch(
      /runPostCommitEffects = async \(\) => \{[\s\S]*if \(clinicalEffectsHeld\)[\s\S]*news2: null,[\s\S]*alerts: \[\],[\s\S]*triage: null/,
    );
    expect(vitalsService).toMatch(/if \(!clinicalEffectsHeld\) await deferPostCommitEffects/);
    expect(vitalsService).toMatch(/if \(needsRescore && !clinicalEffectsHeld\)/);
    expect(importService).toMatch(
      /vitals\.device_verified IS DISTINCT FROM FALSE[\s\S]*news2_effects_completed_at IS NULL/,
    );
    expect(importService).toMatch(
      /reconcilePendingFhirVitalEffects[\s\S]*JOIN vitals_chart AS vitals[\s\S]*vitals\.device_verified IS DISTINCT FROM FALSE/,
    );
  });

  test('the queue and transition lock an exact active-patient row and require clinical authority', () => {
    expect(verificationService).toMatch(
      /source IN \('device', 'fhir'\) AND device_verified = false[\s\S]*recovery_inbox_id IS NULL/,
    );
    expect(verificationService).toMatch(
      /JOIN users AS patient[\s\S]*patient\.is_active = TRUE[\s\S]*patient\.merged_into_uid IS NULL[\s\S]*JOIN users AS actor[\s\S]*FOR UPDATE OF vitals/,
    );
    expect(verificationService).toMatch(
      /fhirVerifier = isClinical\(verifierRole\) \|\| isDoctor\(verifierRole\)[\s\S]*FHIR_VITAL_VERIFIER_ROLE_REQUIRED/,
    );
    expect(verificationService).toMatch(
      /eventType: `vitals\.\$\{sourceKind\}_verified`[\s\S]*timelineIdempotencyKey: idempotencyKey[\s\S]*auditIdempotencyKey: idempotencyKey/,
    );
    expect(verificationService).toMatch(/reconcileVerifiedFhirVitalEffects/);
    expect(verificationRoutes).toMatch(/if \(!canVerify\(req\.user\?\.role\)\)/);
  });

  test('new identity resolution expires aliases while exact receipt replay stays first', () => {
    expect(importService).toMatch(
      /identifier_type='external_emr'[\s\S]*expires_at IS NULL OR expires_at > clock_timestamp\(\)/,
    );
    const preliminaryReplay = importService.indexOf(
      'const replay = await lockClinicalImportDocumentReceiptTx(lockTx, preliminaryReceiptAuthority)',
    );
    const identityResolution = importService.indexOf(
      'const identityClaims = collectFhirPatientIdentityClaims(bundle, targetPatientUid)',
    );
    expect(preliminaryReplay).toBeGreaterThan(-1);
    expect(preliminaryReplay).toBeLessThan(identityResolution);
  });

  test('imported medication evidence retains source status and explicit unverified provenance', () => {
    expect(importService).toMatch(
      /eventType: 'medication\.history_imported',[\s\S]*eventStatus: status/,
    );
    expect(importService).toMatch(/source_status: sourceStatus/);
    expect(importService).toMatch(/source_medication_status: sourceStatus/);
    expect(importService).toMatch(/verification_status: 'asserted_unverified'/);
    expect(importService).toMatch(/'asserted-unverified'/);
  });
});
