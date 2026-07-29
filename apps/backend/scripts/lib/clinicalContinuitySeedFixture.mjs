export const CLINICAL_CONTINUITY_SEED_FIXTURE = Object.freeze({
  tenantId: '13131313-1313-4313-8313-131313131313',
  tenantSlug: 'continuity-seed-inert',
  facilityId: 2147000313,
  facilityCode: 'CONTINUITY-SEED-INERT',
  policyId: '31313131-3131-4313-8313-313131313131',
  policySigningKeyId: 'seed-continuity-policy-k1',
  currentPackSigningKeyId: 'seed-continuity-pack-k1',
  policySigningPublicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaSeZ+9NDm8vYonZJZ2vEYk0z6YfO+40cAMxxOYPHBK4=
-----END PUBLIC KEY-----
`,
  policySigningPublicKeySha256: 'c2a63af6e13caa9712163d25fbf5066e4e947d2b7679cb24e550b30d9f1bb5d4',
  currentPackSigningPublicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaU4n3YxCmjtunXtREC4DiL46s1BHugSEjwc3jgi4bGc=
-----END PUBLIC KEY-----
`,
  currentPackSigningPublicKeySha256: '616f543db4116287da2dbcb66032c2585f43bc19c100090a5f6ab11a629d68f5',
  policyChecksum: 'a963859291d01aacc7245f6147194fda2f3aa52eac52d86ae03d6179e48bf957',
  policySignature: 'K3FNvSm8iDI7XevUUEg//uxphptl768FT2eU6FZ+eAobWD8Bagq/TyktZca+TRfjuRVv9d5Fx/VqN9oDywmRDw==',
  effectiveFrom: '2026-07-29T00:00:00.000Z',
  policyDocument: {
    audience: {
      tenantId: '13131313-1313-4313-8313-131313131313',
      facilityId: '2147000313',
    },
    fieldPolicy: {
      allergyUnknownText: 'Allergy status UNKNOWN — not recorded',
      bloodGroupIncluded: false,
      codeStatusUnknownText: 'Code status NOT RECORDED — confirm per hospital policy',
      contextFields: [
        'bedLocation',
        'attendingDoctor',
        'diagnosisOrChiefComplaint',
        'latestVitals',
        'news2',
        'recentReleasedResults',
        'careTeam',
      ],
      isolationSource: 'structured_only',
      opdDestroyAfterClinicDay: true,
      paediatricWeightRequired: true,
      recentlyAdministeredLookbackHours: 12,
      safetyFieldRecordedAtRequired: true,
      safetyFields: [
        'identity.name',
        'identity.mrnOrUid',
        'identity.dateOfBirth',
        'allergies',
        'codeStatus',
        'medicationsDue',
        'activeMedicationOrders',
        'recentlyAdministeredMedications',
        'unresolvedCriticalResults',
      ],
    },
    generation: {
      currentForMinutes: 15,
      hardExpiryHours: 24,
      historicalMode: false,
      intervalMinutes: 15,
    },
    includedAreas: {
      ed: true,
      opd: true,
      paediatrics: true,
      wards: true,
    },
    medicationsDueWindow: {
      lookaheadHours: 12,
      lookbackHours: 1,
    },
    packSchemaVersion: 1,
    policySchemaVersion: 1,
    policyType: 'clinical_continuity_pack',
    recentReleasedResults: {
      itemCodeAllowlist: ['HGB'],
      lookbackHours: 72,
      maxPerPatient: 10,
      portalReleaseDelayHours: 24,
    },
    requiredCoverage: {
      wards: [{
        wardId: 2147000301,
        locationIdentifier: 'seed-ward',
        label: 'Seed ward',
      }],
      paediatricWards: [{
        wardId: 2147000302,
        locationIdentifier: 'seed-paeds',
        label: 'Seed paediatrics',
      }],
      edBoards: [{
        locationIdentifier: 'seed-ed-board',
        label: 'Seed emergency board',
      }],
      opdClinicDays: [{
        locationIdentifier: 'seed-opd-day',
        queueIds: [2147000303],
        label: 'Seed OPD clinic day',
      }],
    },
  },
});
