"use client";

// src/hooks/useIdempotencyKey.ts
//
// React binding for `lib/idempotencyKey`. The store lives in a ref so it
// survives re-renders (a key kept in state would be re-minted by the render
// that a pending mutation triggers, which is exactly the bug this guards).
//
// Usage:
//
//   const runKey = useIdempotencyKey("payroll-run");
//   ...
//   onClick={() => runMut.mutate({ month, year })}
//   mutationFn: (data) => runPayroll(data, runKey.keyFor(payloadIdentity(data)))
//   onSuccess: () => runKey.reset()
//
// `keyFor` is stable while the payload is unchanged, so a double-click or a
// transport retry replays server-side; `reset()` on success ends the attempt so
// a deliberate second run of the same month actually runs.

import {
  type AttemptKeyStore,
  createAttemptKeyStore,
} from "@/lib/idempotencyKey";
import { useRef } from "react";

export function useIdempotencyKey(scope: string): AttemptKeyStore {
  const ref = useRef<AttemptKeyStore | null>(null);
  if (ref.current === null) {
    ref.current = createAttemptKeyStore(scope);
  }
  return ref.current;
}

export default useIdempotencyKey;
