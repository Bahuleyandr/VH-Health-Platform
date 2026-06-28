// Poll cadence for the OR Board. Status/schedule/cancel push live; the secondary fields (WHO phases,
// checklist, complications) ride this poll, so the live interval stays a modest 2 min (vs the original 60s
// fallback when WS is down) — never worse than before, status changes far fresher.
export const OR_LIVE_POLL_MS = 120_000;
export const OR_FALLBACK_POLL_MS = 60_000;

export function orRefetchMs(subscribed: boolean): number {
  return subscribed ? OR_LIVE_POLL_MS : OR_FALLBACK_POLL_MS;
}
