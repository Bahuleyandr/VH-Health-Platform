// src/config/privilegeGates.js
//
// Central registry of the clinical credential/privilege ENFORCEMENT gates.
// Each gate is turned on by its own env flag (default OFF), and when on it
// requires the responsible clinician to hold an active privilege credential
// (see credentialingService.assertPrivilegeForGate).
//
// This registry exists so that:
//   (a) every gate flag is documented in ONE place (canonical names),
//   (b) validateEnv can validate the flags' values, and
//   (c) the app logs each gate's resolved on/off state at boot — so a mistyped
//       flag name can't silently leave a gate disabled without anyone noticing
//       (the "I set the flag but it stayed off" hazard).
//
// The env flag is the AUTHORITATIVE runtime switch. A privilege_catalog row's
// `metadata.gate_enabled` is only a record of the owner's activation decision,
// NOT a live switch — do not rely on it to enable/disable enforcement.

// Same truthy semantics as credentialingService.isGateEnabled, replicated here
// to keep this config module dependency-free (no service imports at boot).
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function gateFlagEnabled(envVar) {
  return TRUTHY.has(String(process.env[envVar] ?? '').trim().toLowerCase());
}

// Every env-flagged credential gate in the platform. Keep in sync with the
// isGateEnabled(...) / process.env reads in the owning services.
export const PRIVILEGE_GATES = Object.freeze([
  { envVar: 'THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE', label: 'Theatre — primary surgeon (booking)', privilegeKey: 'primary_surgeon' },
  { envVar: 'THEATRE_REQUIRE_OT_READY_SURGEON_PRIVILEGE', label: 'Theatre — OT-ready surgeon', privilegeKey: 'primary_surgeon' },
  { envVar: 'ANESTHESIA_REQUIRE_FINALIZE_PRIVILEGE', label: 'Anaesthesia — record finalize', privilegeKey: 'anesthesia_finalize' },
  { envVar: 'CTVS_ENFORCE_PERFUSIONIST_SIGNOFF_PRIVILEGE', label: 'CTVS — perfusionist sign-off', privilegeKey: 'ctvs_perfusionist_signoff_owner_supplied' },
  { envVar: 'CATH_LAB_PRIVILEGE_GATE_ENABLED', label: 'Cath lab — procedure log', privilegeKey: 'cath_lab_owner_supplied_privilege' },
  { envVar: 'CHEMO_REQUIRE_ADMIN_PRIVILEGE', label: 'Chemotherapy — administration', privilegeKey: 'chemo_administration' },
  { envVar: 'CONTROLLED_SUBSTANCE_REQUIRE_PRESCRIBE_PRIVILEGE', label: 'Controlled-substance prescribing', privilegeKey: 'controlled_substance_prescribe' },
  { envVar: 'RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED', label: 'Radiation oncology — plan/fraction/administration', privilegeKey: 'radiation_oncology_access' },
  { envVar: 'OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED', label: 'OBGyn — labour-ward acts', privilegeKey: 'obgyn_labour_ward_access' },
]);

// Gates that are always enforced (no env flag); listed for completeness.
export const ALWAYS_ON_GATES = Object.freeze([
  { label: 'Cath report signing', privilegeKey: 'cath_report_signing' },
]);

export function resolvePrivilegeGateStates() {
  return PRIVILEGE_GATES.map((gate) => ({ ...gate, enabled: gateFlagEnabled(gate.envVar) }));
}

// One-line boot summary of which gates are enforced. Call once at server start.
export function logPrivilegeGateStates(log) {
  const states = resolvePrivilegeGateStates();
  const enforced = states.filter((gate) => gate.enabled);
  const summary = states.map((gate) => `${gate.envVar}=${gate.enabled ? 'ON' : 'off'}`).join(', ');
  log.info(
    `Credential gates: ${enforced.length}/${states.length} env-flagged gates enforced `
    + `(+${ALWAYS_ON_GATES.length} always-on). ${summary}`,
  );
  return states;
}
