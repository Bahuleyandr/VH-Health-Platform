export const DIALYSIS_CHANNEL = "staff:dialysis-board";

// While the WS channel is subscribed, dialysis events push refetches; relax the
// per-tab safety polls to 2 min. When WS is down, revert to the original cadence.
export const DIALYSIS_LIVE_POLL_MS = 120_000;

export function dialysisRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? DIALYSIS_LIVE_POLL_MS : baseMs;
}
