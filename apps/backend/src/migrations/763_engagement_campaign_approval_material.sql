-- 763_engagement_campaign_approval_material.sql
--
-- Bind an engagement campaign's approval to the material approved.
-- approveCampaign recorded who approved and when, nothing about what; the
-- audience hash was written but never compared (and covered only caller
-- metadata), materialize was allowed after approval, and the due-recipient
-- query ignored the approved snapshot (audit row OPEN-16). The service now
-- writes the canonical approval material and its hash at submit, stamps the
-- approved hash at approve after re-verifying, refuses re-materialization once
-- approved, and re-verifies at queue time before selecting recipients from the
-- approved snapshot only. frozen_audience_hash is kept and now holds the
-- recipients hash of the approved audience, written at submit.
--
-- Forward-only. Existing rows are not rewritten. A campaign approved before
-- this migration carries no approved_material_hash; the queue path returns it
-- to draft for re-approval (ENGAGEMENT_APPROVAL_MATERIAL_MISSING) instead of
-- dispatching, so the legacy set drains itself on first use.
--
-- The CHECK below is added NOT VALID only because such legacy rows may exist
-- at the moment it is applied. It is NOT meant to stay unvalidated (the OPEN-15
-- debt class). Validate it in a follow-up migration once this query returns 0:
--
--   SELECT count(*) FROM engagement_campaigns
--    WHERE status IN ('scheduled', 'running') AND approved_material_hash IS NULL;
--
--   ALTER TABLE engagement_campaigns
--     VALIDATE CONSTRAINT engagement_campaigns_approved_material_check;
--
-- On a freshly migrated database the query is 0 immediately.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE engagement_campaigns
  ADD COLUMN approval_material JSONB,
  ADD COLUMN approval_material_hash VARCHAR(64),
  ADD COLUMN approved_material_hash VARCHAR(64);

ALTER TABLE engagement_campaigns
  ADD CONSTRAINT engagement_campaigns_approved_material_check
  CHECK (status NOT IN ('scheduled', 'running') OR approved_material_hash IS NOT NULL)
  NOT VALID;

COMMIT;
