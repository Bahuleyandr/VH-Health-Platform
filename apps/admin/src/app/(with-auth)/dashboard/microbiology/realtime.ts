export const MICRO_CHANNEL = "staff:micro";

// The Resistance tab polled 60s; Orders/Antibiogram/OrderDetail had no poll (push-only now). While
// subscribed we relax the Resistance poll to a 2-min safety net (push makes it instant), reverting to 60s
// when WS is down so behaviour is never worse than before.
export const MICRO_LIVE_POLL_MS = 120_000;

export function microRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? MICRO_LIVE_POLL_MS : baseMs;
}
