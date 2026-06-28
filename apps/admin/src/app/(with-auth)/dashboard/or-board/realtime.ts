// Poll cadence for the OR Board. Every board field now pushes live (case lifecycle + WHO phases +
// complications + checklist + notes), so while subscribed we drop to a 5-min safety poll; if the socket
// drops, revert to the original 60s so behaviour is never worse than before.
export const OR_LIVE_POLL_MS = 300_000;
export const OR_FALLBACK_POLL_MS = 60_000;

export function orRefetchMs(subscribed: boolean): number {
  return subscribed ? OR_LIVE_POLL_MS : OR_FALLBACK_POLL_MS;
}
