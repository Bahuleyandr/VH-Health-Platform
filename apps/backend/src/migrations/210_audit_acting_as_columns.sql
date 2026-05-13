-- 210_audit_acting_as_columns.sql
--
-- Add explicit actor / subject / acting-as columns to the three audit
-- surfaces so the acting-as delegation flow (X-Acting-As-Uid header,
-- jwtMiddleware rewrite) records BOTH the human pressing the button
-- and the patient whose record was accessed.
--
-- Pre-existing columns retain their previous semantics:
--   * hipaa_access_log.accessed_by  — keeps being "the actor".
--   * audit_logs.uid                — keeps being "the actor".
--   * audit_log.uid / .user_id      — keep being "the actor".
--
-- New columns are explicit so reports/queries don't have to infer:
--   * actor_uid             uuid     — the human pressing the button.
--     When the request carried X-Acting-As-Uid and the delegation hop
--     succeeded, this is the guardian's uid (req.acting.actorUid).
--     Otherwise this is identical to the existing actor column.
--     Nullable because anonymous/system paths still write audit rows.
--   * subject_uid           uuid     — the patient whose record was
--     touched (req.user.uid AFTER any rewrite). For non-delegated
--     requests this equals actor_uid. Nullable for the same reason.
--   * acting_as_dependent   boolean  — TRUE iff the request was an
--     X-Acting-As-Uid delegation. Lets compliance dashboards filter
--     delegated PHI accesses without joining on actor != subject.
--
-- Additive / nullable / defaulted — safe to apply against a live DB.

ALTER TABLE public.hipaa_access_log
    ADD COLUMN IF NOT EXISTS actor_uid uuid,
    ADD COLUMN IF NOT EXISTS subject_uid uuid,
    ADD COLUMN IF NOT EXISTS acting_as_dependent boolean NOT NULL DEFAULT false;

ALTER TABLE public.audit_logs
    ADD COLUMN IF NOT EXISTS actor_uid uuid,
    ADD COLUMN IF NOT EXISTS subject_uid uuid,
    ADD COLUMN IF NOT EXISTS acting_as_dependent boolean NOT NULL DEFAULT false;

ALTER TABLE public.audit_log
    ADD COLUMN IF NOT EXISTS actor_uid uuid,
    ADD COLUMN IF NOT EXISTS subject_uid uuid,
    ADD COLUMN IF NOT EXISTS acting_as_dependent boolean NOT NULL DEFAULT false;

-- Indexes scoped to the delegation flag so compliance queries that
-- pull all acting-as accesses for a given window stay cheap. Filtered
-- partial indexes — small and only built for the (rare) acting-as rows.
CREATE INDEX IF NOT EXISTS idx_hipaa_access_log_acting_as
    ON public.hipaa_access_log (actor_uid, accessed_at DESC)
    WHERE acting_as_dependent = true;

CREATE INDEX IF NOT EXISTS idx_audit_logs_acting_as
    ON public.audit_logs (actor_uid, created_at DESC)
    WHERE acting_as_dependent = true;
