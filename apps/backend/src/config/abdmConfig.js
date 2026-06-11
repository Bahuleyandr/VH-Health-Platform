// src/config/abdmConfig.js
// Configuration for ABDM (Ayushman Bharat Digital Mission) integration

export const ABDM_CONFIG = {
  gatewayUrl: process.env.ABDM_GATEWAY_URL || 'https://dev.abdm.gov.in/gateway',
  bridgeUrl: process.env.ABDM_BRIDGE_URL || 'https://dev.abdm.gov.in/devservice/v1',
  clientId: process.env.ABDM_CLIENT_ID || '',
  clientSecret: process.env.ABDM_CLIENT_SECRET || '',
  hipId: process.env.ABDM_HIP_ID || '',
  hipName: process.env.ABDM_HIP_NAME || 'Venkataeswara Hospitals',
  callbackUrl: process.env.ABDM_CALLBACK_URL || '',
  callbackSecret: process.env.ABDM_CALLBACK_SECRET || '',
  enabled: process.env.ABDM_ENABLED === 'true',

  PURPOSES: ['CAREMGT', 'BREAK_THE_GLASS', 'PUBHLTH', 'HPAYMT', 'DSRCH'],
  HI_TYPES: ['OPConsultation', 'Prescription', 'DischargeSummary', 'DiagnosticReport', 'ImmunizationRecord', 'HealthDocumentRecord', 'WellnessRecord'],
};
