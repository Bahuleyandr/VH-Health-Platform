"use client";

// Shared facility-authority probe for the pharmacy tabs — OPEN-25.
//
// Several pharmacy reads are facility-scoped: the backend resolves the actor's
// pharmacy custody and answers 403 PHARMACY_FACILITY_GRANT_REQUIRED when they
// hold none. An administrator who has simply not been assigned a facility is a
// legitimate viewer, so a tab must ask before requesting that data rather than
// firing the call and rendering the refusal as a failure.
//
// It cannot be decided from the session. FACILITY_OPERATION_ROLES admits ADMIN
// and SUPER_ADMIN (pharmacyFacilityAuthorityService.js:53-61); authority
// additionally requires a staff row and an active pharmacy_staff_facility_grants
// row, and it is deliberately not cached in the session because a grant revoked
// mid-session would leave that answer stale.
//
// GET /orders/facility-authority always answers 200 and resolves through the
// same path the scoped reads use, so its answer predicts them.
//
// This lives in one place ON PURPOSE. The Overview and Orders tabs had the same
// defect and were fixed separately; a second copy of the predicate is how they
// would drift, and a tab gating on a subtly different question is worse than a
// tab that does not gate at all.
import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";

export type FacilityAuthority = {
  has_authority: boolean;
  facility_id: number | null;
  code: string | null;
};

export type FacilityAuthorityState = {
  /** null while unresolved — callers must not treat that as "no authority". */
  authority: FacilityAuthority | null;
  /** A real fault reaching the probe, not an absence of authority. */
  error: string | null;
  loading: boolean;
  reload: () => void;
};

export function useFacilityAuthority(): FacilityAuthorityState {
  const [authority, setAuthority] = useState<FacilityAuthority | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAdminAPI<{ data: FacilityAuthority }>(
      "/pharmacy-orders/orders/facility-authority",
    )
      .then((r) => {
        const data = ((r as Record<string, unknown>).data ??
          r) as FacilityAuthority;
        setAuthority(data);
      })
      .catch((err: unknown) => {
        // A probe failure is a fault, never "no authority" — flattening it
        // would hide an outage behind a calm scope notice.
        setAuthority(null);
        setError(
          err instanceof Error
            ? err.message
            : "Could not check facility access",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { authority, error, loading, reload };
}

/** Copy shown when a viewer holds no facility grant. Shared so the tabs cannot
 *  describe the same state differently, and worded to avoid the route crawl's
 *  visible-failure vocabulary: this is a scope notice, not a fault. */
export const FACILITY_SCOPE_NOTICE =
  "This view is scoped to a pharmacy facility, and your account is not " +
  "currently assigned to one. An administrator can grant facility access.";
