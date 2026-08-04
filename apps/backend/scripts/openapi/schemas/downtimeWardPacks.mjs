// apps/backend/scripts/openapi/schemas/downtimeWardPacks.mjs
// Roadmap A3 ward-pack surface (src/routes/downtime/downtimeRoutes.js), mounted
// at /api/v1/downtime behind CLINICAL_STAFF_ROLES + PHI logging.
//
// The 'ward_pack'-scoped downtime_snapshots rows GET /wards and GET /wards/{id}/latest
// read are NOT kept fresh by any recurring schedule: the ward-downtime-packs k8s
// CronJob calls generateWardDowntimePacks() with zero arguments, which branches to the
// separately-gated generateClinicalContinuityPackSets() C3 sweep instead (a different
// 'clinical_continuity_pack' scope, itself flag-disabled everywhere in this repo). Today
// POST /generate (tenantId supplied) is the only code path that ever writes a 'ward_pack'
// row. This is distinct from the C-D14-gated facility-context surface on the same router.

export const operations = {
  'POST /api/v1/downtime/facility-context': {
    summary: 'Issue a signed clinical-continuity facility-context credential',
    description:
      'Authenticated clinical staff submit a device attestation (nonce, signed timestamp, ' +
      'signature) to obtain a signed facility-context credential for the paper-reconciliation ' +
      'surface. Mutates on success. Doubly blocked today: the compile-time ' +
      'CLINICAL_CONTINUITY_C_D14_APPROVED constant (hardcoded false, overridable by no ' +
      'deployment configuration) makes the controller always return 503 ' +
      'CONTINUITY_FACILITY_CONTEXT_UNAVAILABLE; even past that gate the controller always ' +
      'passes an undefined context lifetime, which independently makes issuance throw ' +
      'CONTINUITY_FACILITY_CONTEXT_OWNER_DECISION_REQUIRED pending an owner-approved finite ' +
      'lifetime. The response is never cached (Cache-Control: no-store).',
  },
  'GET /api/v1/downtime/wards': {
    summary: 'List the latest downtime ward pack per ward',
    description:
      'Read-only listing, for authenticated clinical staff, of the most recently generated ' +
      'downtime ward pack metadata for every ward in the caller\'s tenant — not the pack content ' +
      'itself. Not kept fresh by any recurring schedule: the only code path that writes this ' +
      '\'ward_pack\'-scoped data today is a manual call to the generate endpoint below, since the ' +
      'k8s-scheduled sweep writes a different, itself-disabled scope.',
  },
  'GET /api/v1/downtime/wards/{wardId}/latest': {
    summary: "Fetch one ward's latest downtime pack",
    description:
      'Read-only fetch, for authenticated clinical staff, of the latest downtime pack for one ' +
      'ward: the census, unified allergies, code status, active orders, and upcoming MAR due-' +
      'list a ward can safely run on if the backend goes down. `?format=html` returns the ' +
      'self-contained printable document served by the ward PC; without it, the JSON payload ' +
      'has the bulky embedded HTML rendering stripped.',
    pathParameters: {
      wardId: { type: 'integer', minimum: 1 },
    },
  },
  'POST /api/v1/downtime/generate': {
    summary: 'Manually regenerate every ward downtime pack',
    description:
      'ADMIN-only manual trigger (checked in addition to the router-level clinical-staff role ' +
      'gate) that regenerates the downtime pack for every occupied-bed ward in the caller\'s own ' +
      'tenant right now. Not an early run of a scheduled job — it is currently the only code ' +
      'path that writes the \'ward_pack\'-scoped data the two read endpoints above return, since ' +
      'the k8s-scheduled sweep writes a different, itself-disabled scope. Mutates: persists a ' +
      'fresh downtime_snapshots row per ward; a single ward\'s generation failure is logged and ' +
      'skipped rather than aborting the batch.',
  },
};
