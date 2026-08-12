-- 662: retain stable session selectors for targeted live WebSocket revocation.
--
-- A WebSocket ticket has its own jti, distinct from the access token that
-- minted it. Persist the access token's session family and optional stable
-- device selector so revoking a remotely listed session can close its ticket
-- sockets without closing the caller or sibling login families.
--
-- Both columns remain nullable. Existing rows cannot be backfilled safely:
-- their access tokens may carry a family unknown to the registry, and guessing
-- from jti would publish a selector that does not match those tickets. Legacy
-- rows retain exact-jti revocation until their short-lived tokens expire.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.user_active_sessions
  ADD COLUMN IF NOT EXISTS session_family_id TEXT,
  ADD COLUMN IF NOT EXISTS stable_device_id UUID;
