-- 348_step_sessions_reward_eligible.sql
--
-- CAN-012 (step-reward attestation). pointService.awardStepPoints summed ALL of
-- a day's step_sessions toward the STEP_DAILY_GOAL reward, so a future user-typed
-- / self-declared step entry could farm health points. A naive `source <> 'manual'`
-- filter is WRONG here: the in-app pedometer walk (/steps/session/*) legitimately
-- writes rows with the schema-default source='manual', and `source` also drives
-- the hasSyncedSource UX — so reward-eligibility must be modelled as its OWN
-- concept, orthogonal to source provenance.
--
-- Fail-safe DEFAULT false (default-deny): a row earns step points ONLY if an
-- ingestion path explicitly attested it as device-measured. The two existing
-- device paths — the in-app pedometer session (/steps/session/start) and the
-- health-platform sync (/steps/health-sync) — set reward_eligible=true. A future
-- user-typed/self-declared entry leaves it false (the default) and is therefore
-- reward-ineligible without any extra code. A new sync source likewise earns
-- nothing until it is consciously reviewed and attested.
ALTER TABLE step_sessions
  ADD COLUMN IF NOT EXISTS reward_eligible BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every pre-existing session is device/sync-originated (in-app pedometer
-- or a health-platform sync) — there has never been a user-typed entry path — so
-- all existing rows are attested as reward-eligible.
UPDATE step_sessions SET reward_eligible = true WHERE reward_eligible = false;
