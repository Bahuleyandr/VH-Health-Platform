-- 660_retire_exec_digest_benchmark_pack.sql
--
-- Audit #3 P10: retire the deploy-held executive digest and benchmark-pack
-- substrate after its only service was removed. The tables have no remaining
-- runtime reader or writer; keeping them would leave an undocumented dormant
-- surface that can be revived without the intended governance workflow.
--
-- @no-transaction
-- @statement_timeout: 0

SET lock_timeout = '10s';
SET statement_timeout = '0';

DROP TABLE IF EXISTS analytics_exec_digest_deliveries;
DROP TABLE IF EXISTS analytics_exec_digest_subscriptions;
DROP TABLE IF EXISTS analytics_exec_digest_settings;
DROP TABLE IF EXISTS analytics_benchmark_pack_exports;
