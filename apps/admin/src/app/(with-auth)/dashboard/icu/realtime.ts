export const ICU_BOARD_CHANNEL = "staff:icu-board";

// Poll cadence for the ICU board. Admissions / code-status / discharge / flowsheet / assessment / bundle
// changes push live; while subscribed we relax each polling tab to a 2-min safety net (vs its original
// 30/60s), reverting to the original cadence when WS is down so behaviour is never worse than before.
export const ICU_LIVE_POLL_MS = 120_000;

export function icuRefetchMs(subscribed: boolean, baseMs: number): number {
  return subscribed ? ICU_LIVE_POLL_MS : baseMs;
}
