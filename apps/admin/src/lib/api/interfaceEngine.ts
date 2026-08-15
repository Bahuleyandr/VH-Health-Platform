import { fetchAdminAPI, getJSON, postJSON } from './core';

export type InteropDirection = 'inbound' | 'outbound' | 'bidirectional';
export type InteropConnectorKind = 'http_inbound' | 'mllp_listener' | 'http_outbound' | 'file_sftp_poll' | 'manual_upload' | 'internal_backend';
export type InteropProtocol = 'hl7v2' | 'csv' | 'json' | 'fhir_json' | 'other';
export type InteropChannelStatus = 'draft' | 'active' | 'paused' | 'archived';
export type InteropMessageStatus =
  | 'received' | 'parsed' | 'validated' | 'transformed' | 'queued' | 'delivering'
  | 'delivered' | 'failed' | 'dead' | 'quarantined' | 'replay_requested'
  | 'replayed' | 'ignored_duplicate';

export interface InteropChannel {
  id: number;
  tenant_id: string;
  channel_key: string;
  display_name: string;
  source_system_id: number | null;
  target_system_id: number | null;
  direction: InteropDirection;
  connector_kind: InteropConnectorKind;
  protocol: InteropProtocol;
  message_types: string[];
  status: InteropChannelStatus;
  active_version_id: number | null;
  auth_kind: 'tenant_interop_secret' | 'internal' | 'none';
  auth_sender_identifier: string | null;
  retention_days: number;
  max_attempts: number;
  retry_policy: Record<string, unknown>;
  dead_letter_policy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface InteropChannelVersion {
  id: number;
  tenant_id: string;
  channel_id: number;
  version_number: number;
  status: 'draft' | 'candidate' | 'active' | 'retired';
  connector_config: Record<string, unknown>;
  validation_profile: Record<string, unknown>;
  transform_dsl: Record<string, unknown>;
  routing_policy: Record<string, unknown>;
  redaction_profile: Record<string, unknown>;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InteropTransformTest {
  id: number;
  tenant_id: string;
  channel_version_id: number;
  name: string;
  message_type: string | null;
  input_payload_is_synthetic: boolean;
  expected_output: Record<string, unknown>;
  expected_findings: Array<Record<string, unknown>>;
  last_run_status: 'passed' | 'failed' | 'error' | null;
  last_run_at: string | null;
  last_run_summary: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface InteropMessageAttempt {
  id: number;
  message_id: number;
  attempt_number: number;
  phase: string;
  status: 'ok' | 'failed' | 'dead' | 'skipped';
  response_status: number | null;
  safe_error: string | null;
  metrics: Record<string, unknown>;
  created_at: string;
}

export interface InteropMessage {
  id: number;
  tenant_id: string;
  channel_id: number;
  channel_version_id: number;
  direction: InteropDirection;
  protocol: InteropProtocol;
  message_type: string | null;
  external_control_id: string | null;
  dedupe_key: string | null;
  payload_hash: string;
  raw_payload_retained: boolean;
  redacted_preview: string | null;
  parsed_summary: Record<string, unknown>;
  patient_uid: string | null;
  source_table: string | null;
  source_id: string | null;
  status: InteropMessageStatus;
  last_error_code: string | null;
  last_error_safe: string | null;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  attempts?: InteropMessageAttempt[];
}

export interface InteropReplayBatch {
  id: number;
  tenant_id: string;
  channel_id: number;
  requested_by: string | null;
  reason: string;
  selection_filter: Record<string, unknown>;
  mode: string;
  status: string;
  message_count: number;
  safe_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export async function listInterfaceChannels(params: {
  status?: InteropChannelStatus;
  connector_kind?: InteropConnectorKind;
  limit?: number;
} = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.connector_kind) query.connector_kind = params.connector_kind;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ channels: InteropChannel[]; count: number }>(
    '/admin/interface-engine/channels',
    query,
  );
}

export async function createInterfaceChannel(payload: {
  channel_key: string;
  display_name: string;
  direction: InteropDirection;
  connector_kind: InteropConnectorKind;
  protocol: InteropProtocol;
  message_types: string[];
  auth_kind?: 'tenant_interop_secret' | 'internal' | 'none';
  auth_sender_identifier?: string | null;
  retention_days?: number;
  max_attempts?: number;
  metadata?: Record<string, unknown>;
}) {
  return postJSON<InteropChannel>('/admin/interface-engine/channels', payload);
}

export async function createInterfaceVersion(channelId: number, payload: {
  connector_config?: Record<string, unknown>;
  validation_profile?: Record<string, unknown>;
  transform_dsl?: Record<string, unknown>;
  routing_policy?: Record<string, unknown>;
  redaction_profile?: Record<string, unknown>;
}) {
  return postJSON<InteropChannelVersion>(
    `/admin/interface-engine/channels/${channelId}/versions`,
    payload,
  );
}

export async function activateInterfaceVersion(versionId: number) {
  return postJSON<InteropChannelVersion>(
    `/admin/interface-engine/versions/${versionId}/activate`,
    {},
  );
}

export async function createInterfaceTransformTest(versionId: number, payload: {
  name: string;
  message_type?: string | null;
  input_payload: string;
  input_payload_is_synthetic?: boolean;
  expected_output?: Record<string, unknown>;
  expected_findings?: Array<Record<string, unknown>>;
}) {
  return postJSON<InteropTransformTest>(
    `/admin/interface-engine/versions/${versionId}/transform-tests`,
    payload,
  );
}

export async function runInterfaceTransformTest(testId: number) {
  return postJSON<InteropTransformTest>(
    `/admin/interface-engine/transform-tests/${testId}/run`,
    {},
  );
}

export async function listInterfaceMessages(params: {
  channel_id?: number;
  status?: InteropMessageStatus;
  limit?: number;
} = {}) {
  const query: Record<string, string | number> = {};
  if (params.channel_id) query.channel_id = params.channel_id;
  if (params.status) query.status = params.status;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ messages: InteropMessage[]; count: number }>(
    '/admin/interface-engine/messages',
    query,
  );
}

export async function getInterfaceMessage(id: number) {
  return getJSON<InteropMessage>(`/admin/interface-engine/messages/${id}`);
}

export async function markInterfaceMessageDead(id: number, payload: { reason?: string | null }) {
  return fetchAdminAPI<InteropMessage>(`/admin/interface-engine/messages/${id}/mark-dead`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function dispatchInterfaceOutbound(payload: { batch_size?: number } = {}) {
  return postJSON<{ picked: number; delivered: number; failed: number; dead: number }>(
    '/admin/interface-engine/messages/dispatch-now',
    payload,
  );
}

export async function createInterfaceReplayBatch(payload: {
  channel_id: number;
  reason: string;
  mode?: 'retry_delivery' | 'reprocess_original_version' | 'reprocess_current_version' | 'redeliver_external';
  selection_filter?: Record<string, unknown>;
}) {
  return postJSON<InteropReplayBatch>('/admin/interface-engine/replay-batches', payload);
}

export async function listInterfaceReplayBatches(params: { channel_id?: number; limit?: number } = {}) {
  const query: Record<string, string | number> = {};
  if (params.channel_id) query.channel_id = params.channel_id;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ batches: InteropReplayBatch[]; count: number }>(
    '/admin/interface-engine/replay-batches',
    query,
  );
}
