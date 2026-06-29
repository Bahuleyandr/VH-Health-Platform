export const LAB_CHANNEL = "staff:lab";

// The pathologist worklist had NO poll (push-only now); the critical-alerts tab polled 60s. While
// subscribed we relax the alerts poll to a 2-min safety net (push makes it instant), reverting to 60s
// when WS is down so behaviour is never worse than before.
export const LAB_LIVE_POLL_MS = 120_000;

export function labRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? LAB_LIVE_POLL_MS : baseMs;
}
