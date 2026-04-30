/**
 * Admin API client for the Phase A3 integration + webhook registry.
 *
 * Backed by /api/v1/admin/integrations + /webhook-subscriptions +
 * /webhook-deliveries. The page imports the typed wrappers below
 * directly; signing-credential plaintext is never returned by the API
 * so this client only ever sees credential IDs.
 */

import { fetchAdminAPI, getJSON, postJSON } from './core';

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
export type IntegrationStatus = 'active' | 'paused' | 'failed' | 'archived';

export interface Integration {
  id: number;
  tenant_id: string;
  name: string;
  description: string | null;
  integration_type: string;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  active_subscription_count?: number;
  credential_count?: number;
}

export type IntegrationLogType =
  | 'config_change' | 'auth_refresh' | 'webhook_send' | 'webhook_receive'
  | 'mapping_sync' | 'health_check' | 'error';

export type IntegrationLogSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface IntegrationLog {
  id: number;
  tenant_id: string;
  integration_id: number | null;
  log_type: IntegrationLogType;
  severity: IntegrationLogSeverity;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function listIntegrations(params: {
  status?: IntegrationStatus;
  integration_type?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.integration_type) query.integration_type = params.integration_type;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ integrations: Integration[]; count: number }>(
    '/admin/integrations',
    query,
  );
}

export async function createIntegration(payload: {
  name: string;
  description?: string | null;
  integration_type: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  return postJSON<Integration>('/admin/integrations', payload);
}

export async function getIntegration(id: number) {
  return getJSON<Integration>(`/admin/integrations/${id}`);
}

export async function updateIntegration(id: number, payload: {
  name?: string;
  description?: string | null;
  integration_type?: string;
  status?: IntegrationStatus;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  return fetchAdminAPI<Integration>(`/admin/integrations/${id}`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function archiveIntegration(id: number) {
  return fetchAdminAPI<Integration>(`/admin/integrations/${id}/archive`, {
    method: 'PATCH',
    body: {},
  });
}

export async function listIntegrationLogs(integrationId: number, params: {
  severity?: IntegrationLogSeverity;
  log_type?: IntegrationLogType;
  limit?: number;
} = {}) {
  const query: Record<string, string | number> = {};
  if (params.severity) query.severity = params.severity;
  if (params.log_type) query.log_type = params.log_type;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ logs: IntegrationLog[]; count: number }>(
    `/admin/integrations/${integrationId}/logs`,
    query,
  );
}

// ---------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------
export type WebhookSigningAlgorithm = 'hmac-sha256' | 'hmac-sha512' | 'none';

export interface WebhookSubscription {
  id: number;
  integration_id: number;
  tenant_id: string;
  event_type: string;
  event_filter: Record<string, unknown>;
  endpoint_url: string;
  signing_credential_id: number | null;
  signing_algorithm: WebhookSigningAlgorithm;
  is_active: boolean;
  last_delivered_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  max_consecutive_failures: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listIntegrationSubscriptions(integrationId: number) {
  return getJSON<{ subscriptions: WebhookSubscription[]; count: number }>(
    `/admin/integrations/${integrationId}/subscriptions`,
  );
}

export async function listSubscriptions(params: {
  integration_id?: number;
  event_type?: string;
  is_active?: boolean;
  limit?: number;
} = {}) {
  const query: Record<string, string | number | boolean> = {};
  if (params.integration_id) query.integration_id = params.integration_id;
  if (params.event_type) query.event_type = params.event_type;
  if (params.is_active != null) query.is_active = params.is_active;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ subscriptions: WebhookSubscription[]; count: number }>(
    '/admin/webhook-subscriptions',
    query,
  );
}

export async function createSubscription(integrationId: number, payload: {
  event_type: string;
  endpoint_url: string;
  event_filter?: Record<string, unknown>;
  signing_credential_id?: number | null;
  signing_algorithm?: WebhookSigningAlgorithm;
  is_active?: boolean;
  max_consecutive_failures?: number;
  metadata?: Record<string, unknown>;
}) {
  return postJSON<WebhookSubscription>(
    `/admin/integrations/${integrationId}/subscriptions`,
    payload,
  );
}

export async function updateSubscription(id: number, payload: {
  endpoint_url?: string;
  event_filter?: Record<string, unknown>;
  signing_credential_id?: number | null;
  signing_algorithm?: WebhookSigningAlgorithm;
  is_active?: boolean;
  max_consecutive_failures?: number;
  metadata?: Record<string, unknown>;
}) {
  return fetchAdminAPI<WebhookSubscription>(`/admin/webhook-subscriptions/${id}`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function deleteSubscription(id: number) {
  return fetchAdminAPI<{ id: number; integration_id: number; event_type: string; endpoint_url: string }>(
    `/admin/webhook-subscriptions/${id}`,
    { method: 'DELETE', body: undefined },
  );
}

// ---------------------------------------------------------------------------
// Webhook deliveries
// ---------------------------------------------------------------------------
export type WebhookDeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'dead';

export interface WebhookDelivery {
  id: number;
  subscription_id: number | null;
  tenant_id: string;
  event_outbox_id: number | null;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempt_number: number;
  http_status: number | null;
  response_excerpt: string | null;
  error_message: string | null;
  signature: string | null;
  request_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  payload?: Record<string, unknown>;
}

export interface DispatchTickResult {
  dispatched: number;
  succeeded: number;
  failed: number;
  dead: number;
  halted?: boolean;
  reason?: string;
}

export interface EnqueueResult {
  matched: number;
  enqueued: WebhookDelivery[];
  skipped_reason?: string;
}

export async function listDeliveries(params: {
  subscription_id?: number;
  status?: WebhookDeliveryStatus;
  event_type?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string | number> = {};
  if (params.subscription_id) query.subscription_id = params.subscription_id;
  if (params.status) query.status = params.status;
  if (params.event_type) query.event_type = params.event_type;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ deliveries: WebhookDelivery[]; count: number }>(
    '/admin/webhook-deliveries',
    query,
  );
}

export async function getDelivery(id: number) {
  return getJSON<WebhookDelivery>(`/admin/webhook-deliveries/${id}`);
}

export async function enqueueDelivery(payload: {
  event_type: string;
  payload?: Record<string, unknown>;
  event_outbox_id?: number | null;
  request_id?: string | null;
}) {
  return postJSON<EnqueueResult>('/admin/webhook-deliveries/enqueue', payload);
}

export async function dispatchNow(payload: { batch_size?: number } = {}) {
  return postJSON<DispatchTickResult>('/admin/webhook-deliveries/dispatch-now', payload);
}

export async function markDeliveryDead(id: number, payload: { reason?: string | null } = {}) {
  return fetchAdminAPI<WebhookDelivery>(`/admin/webhook-deliveries/${id}/mark-dead`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function redriveDelivery(id: number) {
  return postJSON<WebhookDelivery>(`/admin/webhook-deliveries/${id}/redrive`, {});
}
