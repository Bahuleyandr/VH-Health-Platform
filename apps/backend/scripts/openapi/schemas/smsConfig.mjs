// apps/backend/scripts/openapi/schemas/smsConfig.mjs
// SMS gateway (migrations 699/700): per-tenant provider configs with TRAI
// DLT identity + fail-closed template registrations, served from
// /api/v1/admin/notifications/sms/*, plus the public delivery-status (DLR)
// webhooks at /webhooks/sms/*. Config-gated DEFAULT OFF: every tenant
// resolves to the dry-run logger until tenants.settings.sms.enabled AND an
// enabled sms_provider_configs row (or complete env credentials) exist;
// SMS_PROVIDER=logger is the deployment-wide kill switch.
import { envelope } from './_helpers.mjs';

export const schemas = {
  SmsProviderConfigView: {
    type: 'object',
    required: ['id', 'provider', 'enabled'],
    properties: {
      id: { type: 'integer' },
      provider: { type: 'string', enum: ['msg91', 'twilio', 'dry_run'] },
      enabled: { type: 'boolean' },
      sender_id: {
        type: 'string',
        nullable: true,
        description: 'TRAI DLT registered header (sender id).',
      },
      dlt_entity_id: {
        type: 'string',
        nullable: true,
        description: 'TRAI DLT principal entity id of the tenant hospital.',
      },
      account_sid: { type: 'string', nullable: true, description: 'Twilio account SID (publishable).' },
      has_auth_key: {
        type: 'boolean',
        description: 'Credentials are write-only; reads expose presence booleans only.',
      },
      has_callback_token: { type: 'boolean' },
      callback_token: {
        type: 'string',
        nullable: true,
        description: 'Present ONLY on the upsert response that minted/rotated it — the bearer token for the tenant DLR callback URL. Only its SHA-256 is stored.',
      },
      dlr_path: {
        type: 'string',
        nullable: true,
        description: 'Tenant-specific delivery-status webhook path (/webhooks/sms/dlr/<token> or /webhooks/sms/twilio-status/<token>) to configure at the provider dashboard. Present only alongside callback_token.',
      },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  SmsProviderConfigList: {
    type: 'object',
    required: ['tenant_enabled', 'configs'],
    properties: {
      env_provider: {
        type: 'string',
        nullable: true,
        description: 'SMS_PROVIDER env value (msg91 | twilio | logger) or null when unset.',
      },
      env_kill_switch: { type: 'boolean', description: 'true when SMS_PROVIDER=logger forces dry-run everywhere.' },
      tenant_enabled: { type: 'boolean', description: 'tenants.settings.sms.enabled.' },
      configs: { type: 'array', items: { $ref: '#/components/schemas/SmsProviderConfigView' } },
    },
  },

  SmsProviderConfigUpsertRequest: {
    type: 'object',
    required: ['provider'],
    properties: {
      provider: { type: 'string', enum: ['msg91', 'twilio', 'dry_run'] },
      enabled: { type: 'boolean', description: 'At most one enabled config per tenant (699 partial unique).' },
      sender_id: { type: 'string', nullable: true, maxLength: 20 },
      dlt_entity_id: { type: 'string', nullable: true, maxLength: 40 },
      auth_key: {
        type: 'string',
        nullable: true,
        maxLength: 200,
        description: 'MSG91 authkey / Twilio auth token. Write-only: stored as encryptField() ciphertext, never echoed.',
      },
      account_sid: { type: 'string', nullable: true, maxLength: 64 },
      rotate_callback_token: {
        type: 'boolean',
        description: 'Mint a fresh DLR callback token (invalidates the previous callback URL).',
      },
    },
  },

  SmsTemplateRegistration: {
    type: 'object',
    required: ['id', 'provider_config_id', 'template_key', 'dlt_template_id', 'active'],
    properties: {
      id: { type: 'integer' },
      provider_config_id: { type: 'integer' },
      template_key: {
        type: 'string',
        description: "Outbox template_version key (e.g. 'sms.billing_payment_link.v1'). A send with no active registration is a terminal rejection (dlt_template_not_registered) — never an unregistered send.",
      },
      dlt_template_id: { type: 'string', description: 'TRAI DLT content template id.' },
      provider_template_id: { type: 'string', nullable: true, description: 'MSG91 flow id / Twilio content SID.' },
      active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  SmsTemplateRegistrationList: {
    type: 'object',
    required: ['templates'],
    properties: {
      templates: { type: 'array', items: { $ref: '#/components/schemas/SmsTemplateRegistration' } },
    },
  },

  SmsTemplateCreateRequest: {
    type: 'object',
    required: ['template_key', 'dlt_template_id'],
    properties: {
      template_key: { type: 'string', maxLength: 120 },
      dlt_template_id: { type: 'string', maxLength: 40 },
      provider_template_id: { type: 'string', nullable: true, maxLength: 64 },
      provider_config_id: {
        type: 'integer',
        nullable: true,
        description: 'Defaults to the tenant single/enabled provider config.',
      },
      active: { type: 'boolean' },
    },
  },

  SmsTemplateUpdateRequest: {
    type: 'object',
    properties: {
      dlt_template_id: { type: 'string', nullable: true, maxLength: 40 },
      provider_template_id: { type: 'string', nullable: true, maxLength: 64 },
      active: { type: 'boolean', nullable: true },
    },
  },

  SmsDlrAck: {
    type: 'object',
    required: ['received'],
    properties: {
      received: { type: 'boolean' },
      results: {
        type: 'array',
        items: {
          type: 'string',
          description: 'Per-report handling outcome: recorded | unknown_reference | ignored_intermediate | ignored_unknown_status | ignored_no_reference.',
        },
      },
    },
  },

  SmsProviderConfigListResponse: envelope('SmsProviderConfigList'),
  SmsProviderConfigViewResponse: envelope('SmsProviderConfigView'),
  SmsTemplateRegistrationListResponse: envelope('SmsTemplateRegistrationList'),
  SmsTemplateRegistrationResponse: envelope('SmsTemplateRegistration'),
  SmsDlrAckResponse: envelope('SmsDlrAck'),
};

export const operations = {
  'GET /api/v1/admin/notifications/sms/config': {
    description:
      'Admin read of the tenant SMS provider configs plus the env/tenant gate states. Credentials are write-only — reads expose has_auth_key / has_callback_token booleans only.',
    response: 'SmsProviderConfigListResponse',
  },
  'PUT /api/v1/admin/notifications/sms/config': {
    description:
      'Admin upsert of the per-tenant SMS provider config (one row per provider; at most one enabled per tenant). auth_key is write-only encryptField() ciphertext; enabling a non-dry_run provider without sender_id + dlt_entity_id + auth_key is rejected (699 CHECK). When the row has no DLR callback token (or rotation is requested) a fresh bearer token is minted and returned EXACTLY ONCE as callback_token + dlr_path — only its SHA-256 is stored.',
    request: 'SmsProviderConfigUpsertRequest',
    response: 'SmsProviderConfigViewResponse',
  },
  'GET /api/v1/admin/notifications/sms/templates': {
    description:
      'Lists the tenant DLT template registrations (outbox template_version key → TRAI DLT content template id + provider flow/content id). The adapter refuses to send any template kind without an active registration.',
    response: 'SmsTemplateRegistrationListResponse',
  },
  'POST /api/v1/admin/notifications/sms/templates': {
    description:
      'Registers a DLT content template id for an outbox template key on a provider config (unique per tenant/config/key). Until a template kind is registered, sends of that kind terminally reject with dlt_template_not_registered.',
    request: 'SmsTemplateCreateRequest',
    response: 'SmsTemplateRegistrationResponse',
  },
  'PUT /api/v1/admin/notifications/sms/templates/{id}': {
    description:
      'Updates a template registration (DLT id, provider template id, active flag). Deactivating a registration fail-closes future sends of that template kind.',
    request: 'SmsTemplateUpdateRequest',
    response: 'SmsTemplateRegistrationResponse',
  },
  'POST /webhooks/sms/dlr/{token}': {
    description:
      'Public MSG91 delivery-status (DLR) intake (pre-auth mount). MSG91 does not sign callbacks, so the URL bearer token IS the authentication: SHA-256(token) must match a tenant config callback_token_hash — unknown token 401s and writes nothing (fail-closed, never a default tenant). Only terminal statuses are persisted (delivered → acknowledged receipt; failed/undelivered/rejected/expired → rejected receipt with the operator code), as append-only provider_status_callback evidence correlated by the send-time request id; intermediate statuses, unknown references, and replayed terminal reports are 200-acked without a write. Outbox status is never changed by a DLR.',
    response: 'SmsDlrAckResponse',
  },
  'POST /webhooks/sms/twilio-status/{token}': {
    description:
      'Public Twilio message status callback intake (pre-auth mount). The URL bearer token resolves the tenant fail-closed AND the delivery must carry a valid X-Twilio-Signature (HMAC of the exact public callback URL + sorted form params, verified against the tenant auth token). Terminal statuses (delivered / undelivered / failed) land as append-only provider_status_callback receipts correlated by MessageSid; everything else is 200-acked without a write. Outbox status is never changed by a DLR.',
    response: 'SmsDlrAckResponse',
  },
};
