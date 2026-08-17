// apps/backend/scripts/openapi/schemas/smsConfig.mjs
// SMS gateway (migrations 699/700): per-tenant provider configs with TRAI
// DLT identity + fail-closed template registrations, served from
// /api/v1/admin/notifications/sms/*, plus the public delivery-status (DLR)
// webhooks at /webhooks/sms/*. Config-gated DEFAULT OFF: every tenant
// resolves to the dry-run logger until tenants.settings.sms.enabled AND an
// enabled sms_provider_configs row (or complete env credentials) exist;
// SMS_PROVIDER=logger is the deployment-wide kill switch.
import { envelope } from './_helpers.mjs';

const errorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/SmsDlrErrorResponse' },
    },
  },
});

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
        readOnly: true,
        description: 'Present ONLY on the upsert response that minted/rotated it — the bearer token for the tenant DLR callback URL. The database stores its SHA-256 lookup hash plus an encryptField() ciphertext used only to construct signed Twilio callback URLs; later reads never return either token form.',
      },
      dlr_path: {
        type: 'string',
        nullable: true,
        readOnly: true,
        description: 'Tenant-specific delivery-status webhook path (/webhooks/sms/dlr/<token> or /webhooks/sms/twilio-status/<token>) to configure at the provider dashboard. Present only alongside callback_token; this location is excluded from ingress access logs because the path segment is a credential.',
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
    required: ['provider', 'enabled'],
    properties: {
      provider: { type: 'string', enum: ['msg91', 'twilio', 'dry_run'] },
      enabled: { type: 'boolean', description: 'REQUIRED (explicit true/false): the upsert takes this value verbatim, so omission would silently disable a live config. At most one enabled config per tenant (699 partial unique).' },
      sender_id: { type: 'string', nullable: true, maxLength: 20 },
      dlt_entity_id: { type: 'string', nullable: true, maxLength: 40 },
      auth_key: {
        type: 'string',
        nullable: true,
        maxLength: 200,
        writeOnly: true,
        description: 'MSG91 authkey / Twilio auth token. Write-only: stored as tenant-bound encryptField() ciphertext; validation errors and every response omit the submitted value.',
      },
      account_sid: {
        type: 'string', nullable: true, maxLength: 64,
        description: 'Required by the database whenever a Twilio config is enabled.',
      },
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

  Msg91DlrReport: {
    type: 'object',
    additionalProperties: true,
    properties: {
      status: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      code: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      desc: { type: 'string', nullable: true },
    },
  },

  Msg91DlrEntry: {
    type: 'object',
    additionalProperties: true,
    properties: {
      requestId: { type: 'string' },
      request_id: { type: 'string' },
      status: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      code: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      report: {
        type: 'array',
        maxItems: 50,
        items: { $ref: '#/components/schemas/Msg91DlrReport' },
      },
    },
  },

  Msg91DlrJsonRequest: {
    description: 'Legacy/operator JSON replay shape. Across all entry.report arrays, at most 50 reports are accepted atomically.',
    oneOf: [
      { $ref: '#/components/schemas/Msg91DlrEntry' },
      {
        type: 'array',
        maxItems: 50,
        items: { $ref: '#/components/schemas/Msg91DlrEntry' },
      },
    ],
  },

  Msg91DlrFormRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['data'],
    properties: {
      data: {
        type: 'string',
        description: 'JSON-encoded MSG91 report object/array. The decoded aggregate may contain at most 50 reports; larger authenticated batches receive 413 before any receipt is written.',
      },
    },
  },

  TwilioSmsStatusFormRequest: {
    type: 'object',
    additionalProperties: true,
    anyOf: [
      { required: ['MessageSid', 'MessageStatus'] },
      { required: ['SmsSid', 'SmsStatus'] },
    ],
    properties: {
      MessageSid: { type: 'string' },
      SmsSid: { type: 'string' },
      MessageStatus: { type: 'string' },
      SmsStatus: { type: 'string' },
      ErrorCode: { type: 'string', nullable: true },
    },
  },

  SmsDlrErrorResponse: {
    type: 'object',
    additionalProperties: true,
    required: ['success'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      error: { type: 'string' },
      code: { type: 'string' },
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
      'Admin upsert of the per-tenant SMS provider config (one row per provider; at most one enabled per tenant). auth_key is write-only tenant-bound encryptField() ciphertext and validator failures never echo it; enabling a non-dry_run provider without sender_id + dlt_entity_id + auth_key is rejected, and enabled Twilio additionally requires account_sid (699 + 711 checks). When the row has no DLR callback token (or rotation is requested) a fresh bearer token is minted and returned EXACTLY ONCE as callback_token + dlr_path; only its SHA-256 lookup hash and encryptField() ciphertext are retained.',
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
    security: [],
    pathParameters: {
      token: { type: 'string', pattern: '^[A-Za-z0-9_.-]{20,160}$' },
    },
    requestContent: {
      'application/x-www-form-urlencoded': 'Msg91DlrFormRequest',
      'application/json': 'Msg91DlrJsonRequest',
    },
    response: 'SmsDlrAckResponse',
    additionalResponses: {
      400: errorResponse('The authenticated MSG91 data field was not valid JSON report data.'),
      401: errorResponse('The callback path token was missing, malformed, or unknown.'),
      413: errorResponse('The authenticated decoded batch exceeded 50 reports; no report was processed.'),
      429: errorResponse('The callback source exceeded the public webhook rate limit.'),
      500: errorResponse('The authenticated report could not be recorded; the provider may retry.'),
    },
  },
  'POST /webhooks/sms/twilio-status/{token}': {
    description:
      'Public Twilio message status callback intake (pre-auth mount). The URL bearer token resolves the tenant fail-closed AND the delivery must carry a valid X-Twilio-Signature (HMAC of the exact public callback URL + sorted form params, verified against the tenant auth token). Terminal statuses (delivered / undelivered / failed) land as append-only provider_status_callback receipts correlated by MessageSid; everything else is 200-acked without a write. Outbox status is never changed by a DLR.',
    security: [],
    pathParameters: {
      token: { type: 'string', pattern: '^[A-Za-z0-9_.-]{20,160}$' },
    },
    parameters: [{
      name: 'X-Twilio-Signature',
      in: 'header',
      required: true,
      schema: { type: 'string' },
      description: 'Twilio signature over the exact PUBLIC_BASE_URL callback URL and form fields.',
    }],
    requestContent: {
      'application/x-www-form-urlencoded': 'TwilioSmsStatusFormRequest',
    },
    response: 'SmsDlrAckResponse',
    additionalResponses: {
      400: errorResponse('The callback form body was malformed.'),
      401: errorResponse('The callback token, account-bound auth token, PUBLIC_BASE_URL, or Twilio signature could not be verified.'),
      429: errorResponse('The callback source exceeded the public webhook rate limit.'),
      500: errorResponse('The authenticated status could not be recorded; Twilio may retry.'),
    },
  },
};
