BEGIN;

ALTER TABLE video_sessions
  DROP CONSTRAINT IF EXISTS video_sessions_provider_check;

ALTER TABLE video_sessions
  ADD CONSTRAINT video_sessions_provider_check
  CHECK (provider IN ('zoom', 'daily', 'jitsi', 'twilio', 'agora', 'webrtc_native', 'livekit', 'other'));

ALTER TABLE teleconsult_provider_configs
  DROP CONSTRAINT IF EXISTS teleconsult_provider_configs_provider_check;

ALTER TABLE teleconsult_provider_configs
  ADD CONSTRAINT teleconsult_provider_configs_provider_check
  CHECK (provider IN ('zoom', 'daily', 'jitsi', 'twilio', 'agora', 'webrtc_native', 'livekit', 'other'));

COMMIT;
