// src/config/uhiConfig.js
// Configuration for the UHI (Unified Health Interface) adapter — DHP/beckn
// health-service discovery + booking network. Provider-side (HSP) only.
//
// Ship-disabled posture: UHI_ENABLED is the deployment kill switch (default
// off, zero live credentials shipped); tenants.settings.uhi.enabled is the
// per-hospital opt-in (tenantSettingsService.getUhiSettings). Sandbox is the
// default environment everywhere.

export const UHI_CONFIG = {
  enabled: process.env.UHI_ENABLED === 'true',
  // DHP sandbox gateway by default; production sets UHI_GATEWAY_URL explicitly.
  gatewayUrl: process.env.UHI_GATEWAY_URL || 'https://gateway.uhi.abdm.gov.in/api/v1',
  // Our subscriber identity on the network (HSP id registered with the UHI
  // registry). Also the default-tenant sender identifier for inbound
  // tenant resolution (tenant_interop_secrets rows win, ABDM W3 model).
  subscriberId: process.env.UHI_SUBSCRIBER_ID || '',
  // ed25519 signing keypair for our outbound on_* callbacks (base64 raw keys).
  signingPrivateKey: process.env.UHI_SIGNING_PRIVATE_KEY || '',
  signingKeyId: process.env.UHI_SIGNING_KEY_ID || '',
  // Trusted counterparty (gateway) ed25519 PUBLIC key for inbound signature
  // verification on the env-backed default tenant. Per-tenant keys live in
  // tenant_interop_secrets (kind 'uhi_callback').
  gatewayPublicKey: process.env.UHI_GATEWAY_PUBLIC_KEY || '',
  environment: process.env.UHI_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
  // Beckn domain/city defaults for the DHP context we answer with.
  domain: process.env.UHI_DOMAIN || 'nic2004:85110',
  city: process.env.UHI_CITY || 'std:044',
  country: process.env.UHI_COUNTRY || 'IND',

  ACTIONS: ['search', 'init', 'confirm', 'status', 'cancel'],
};

export default UHI_CONFIG;
