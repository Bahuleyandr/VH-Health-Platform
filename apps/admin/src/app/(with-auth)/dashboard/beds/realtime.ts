// Poll cadence for the Beds dashboard. When the admin:beds subscription is live,
// a 5-min safety poll backstops the at-most-once WS bus; if WS drops/denies, we
// revert to the original 60s poll so behaviour is never worse than before.
export const BEDS_LIVE_POLL_MS = 300_000;
export const BEDS_FALLBACK_POLL_MS = 60_000;

export function bedsRefetchMs(subscribed: boolean): number {
  return subscribed ? BEDS_LIVE_POLL_MS : BEDS_FALLBACK_POLL_MS;
}
