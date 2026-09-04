// src/services/clinical/bloodborneMarkerService.js
//
// Platform-level patient blood-borne marker record. The pure rules (value
// normaliser, reuse resolver, exposure registry) live in
// bloodborneMarkerRules.js and are re-exported here; the persistence functions
// (record, list, void, lab sign-off ingestion) are added in the next task.
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7.
//
// Consumers today: cath-lab device reuse (restriction strip, post-use rules,
// late-result quarantine). Named future consumers: OT sign-in, dialysis.
// Writers: the lab sign-off hook and the cath readiness checklist's
// external-result / clinical-declaration paths. There is deliberately no
// general create endpoint.

export * from './bloodborneMarkerRules.js';
export { markerForResult } from '../lab/labAnalyteCodes.js';
