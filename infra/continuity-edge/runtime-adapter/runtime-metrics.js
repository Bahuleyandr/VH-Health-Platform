export function recordContinuityVerificationFailure() {
  // The edge writes node-exporter textfile metrics after the exact verifier
  // returns. This adapter intentionally has no backend in-process registry.
}
