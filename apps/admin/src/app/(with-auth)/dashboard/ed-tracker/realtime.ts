// Poll cadence for the ED board. When the staff:ed-board subscription is live, a
// 2-min safety poll backstops the at-most-once WS bus; if WS drops/denies, we
// revert to the original 30s poll so behaviour is never worse than before.
export const ED_LIVE_POLL_MS = 120_000;
export const ED_FALLBACK_POLL_MS = 30_000;

export function edRefetchMs(subscribed: boolean): number {
  return subscribed ? ED_LIVE_POLL_MS : ED_FALLBACK_POLL_MS;
}
