// Poll cadence for the Operations snapshot. The WS push keeps it fresh, so while subscribed we drop to a
// 5-min safety poll; if the socket drops, revert to the original 60s so behaviour is never worse than before.
export const OPS_LIVE_POLL_MS = 300_000;
export const OPS_FALLBACK_POLL_MS = 60_000;

export function opsRefetchMs(subscribed: boolean): number {
  return subscribed ? OPS_LIVE_POLL_MS : OPS_FALLBACK_POLL_MS;
}
