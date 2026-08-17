// src/config/abdmConfig.js
// Configuration for ABDM (Ayushman Bharat Digital Mission) integration

const IS_PRODUCTION_ABDM = process.env.ABDM_ENVIRONMENT === 'production';

export const ABDM_CONFIG = {
  gatewayUrl: process.env.ABDM_GATEWAY_URL
    || (IS_PRODUCTION_ABDM ? '' : 'https://dev.abdm.gov.in/gateway'),
  bridgeUrl: process.env.ABDM_BRIDGE_URL
    || (IS_PRODUCTION_ABDM ? '' : 'https://dev.abdm.gov.in/devservice/v1'),
  // ABHA enrolment API (v3) base — sandbox by default; production sets
  // ABHA_ENROLMENT_BASE_URL explicitly alongside ABDM_ENVIRONMENT.
  abhaEnrolmentBaseUrl: process.env.ABHA_ENROLMENT_BASE_URL || 'https://abhasbx.abdm.gov.in/abha/api/v3',
  clientId: process.env.ABDM_CLIENT_ID || '',
  clientSecret: process.env.ABDM_CLIENT_SECRET || '',
  hipId: process.env.ABDM_HIP_ID || '',
  hipName: process.env.ABDM_HIP_NAME || 'Venkataeswara Hospitals',
  // HIU identity for the thin HIU leg; defaults to the HIP id (single facility
  // registered as both bridges).
  hiuId: process.env.ABDM_HIU_ID || process.env.ABDM_HIP_ID || '',
  callbackUrl: process.env.ABDM_CALLBACK_URL || '',
  callbackSecret: process.env.ABDM_CALLBACK_SECRET || '',
  enabled: process.env.ABDM_ENABLED === 'true',
  // Explicit environment (was implicit: gateway hardcoded X-CM-ID 'sbx').
  // 'sandbox' unless ABDM_ENVIRONMENT=production; ABDM_CM_ID overrides the
  // Consent-Manager id header independently (sandbox default 'sbx').
  environment: IS_PRODUCTION_ABDM ? 'production' : 'sandbox',
  cmId: process.env.ABDM_CM_ID
    || (process.env.ABDM_ENVIRONMENT === 'production' ? '' : 'sbx'),

  PURPOSES: ['CAREMGT', 'BREAK_THE_GLASS', 'PUBHLTH', 'HPAYMT', 'DSRCH'],
  HI_TYPES: ['OPConsultation', 'Prescription', 'DischargeSummary', 'DiagnosticReport', 'ImmunizationRecord', 'HealthDocumentRecord', 'WellnessRecord'],
};
