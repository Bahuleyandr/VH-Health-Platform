// apps/backend/scripts/openapi/schemas/money.mjs
// Typed request/response payload schemas for the money/billing surface.
// Populated per sub-surface in Phase 5 tasks T3–T8.
import { envelope } from './_helpers.mjs';

export const schemas = {
  // ---- GL ledger reports (read-only; ledgerReportsService.js) ----
  TrialBalanceAccount: {
    type: 'object', additionalProperties: false,
    required: ['code', 'type', 'balancePaise', 'balance'],
    properties: {
      code: { type: 'string', example: 'PATIENT_AR' },
      type: { type: 'string', enum: ['ASSET', 'LIABILITY', 'REVENUE', 'EQUITY', 'CONTRA'] },
      balancePaise: { type: 'integer', example: 100000 },
      balance: { type: 'string', example: '1000.00' },
    },
  },
  TrialBalance: {
    type: 'object', additionalProperties: false,
    required: ['accounts', 'signedTotalPaise', 'balanced'],
    properties: {
      accounts: { type: 'array', items: { $ref: '#/components/schemas/TrialBalanceAccount' } },
      signedTotalPaise: { type: 'integer', example: 0 },
      balanced: { type: 'boolean', example: true },
    },
  },
  TrialBalanceResponse: envelope('TrialBalance'),

  AgingBucket: {
    type: 'object', additionalProperties: false,
    required: ['bucket', 'invoiceCount', 'totalPaise', 'total'],
    properties: {
      bucket: { type: 'string', enum: ['0-30', '31-60', '61-90', '90+'] },
      invoiceCount: { type: 'integer', example: 3 },
      totalPaise: { type: 'integer', example: 250000 },
      total: { type: 'string', example: '2500.00' },
    },
  },
  AgingReport: {
    type: 'object', additionalProperties: false,
    required: ['buckets', 'grandTotalPaise', 'grandTotal'],
    properties: {
      buckets: { type: 'array', items: { $ref: '#/components/schemas/AgingBucket' } },
      grandTotalPaise: { type: 'integer', example: 250000 },
      grandTotal: { type: 'string', example: '2500.00' },
    },
  },
  AgingReportResponse: envelope('AgingReport'),

  DrawerPosition: {
    type: 'object', additionalProperties: false,
    required: ['drawerSessionId', 'netPaise', 'net'],
    properties: {
      drawerSessionId: { type: 'integer', example: 12 },
      netPaise: { type: 'integer', example: 50000 },
      net: { type: 'string', example: '500.00' },
    },
  },
  CashPosition: {
    type: 'object', additionalProperties: false,
    required: ['cashTotalPaise', 'cashTotal', 'bankTotalPaise', 'bankTotal', 'byDrawer'],
    properties: {
      cashTotalPaise: { type: 'integer', example: 50000 },
      cashTotal: { type: 'string', example: '500.00' },
      bankTotalPaise: { type: 'integer', example: 0 },
      bankTotal: { type: 'string', example: '0.00' },
      byDrawer: { type: 'array', items: { $ref: '#/components/schemas/DrawerPosition' } },
    },
  },
  CashPositionResponse: envelope('CashPosition'),

  DailyCollectionDay: {
    type: 'object', additionalProperties: false,
    required: ['day', 'collectedPaise', 'collected'],
    properties: {
      day: { type: 'string', example: '2026-06-24' },
      collectedPaise: { type: 'integer', example: 75000 },
      collected: { type: 'string', example: '750.00' },
    },
  },
  DailyCollection: {
    type: 'object', additionalProperties: false,
    required: ['days', 'totalPaise', 'total'],
    properties: {
      days: { type: 'array', items: { $ref: '#/components/schemas/DailyCollectionDay' } },
      totalPaise: { type: 'integer', example: 75000 },
      total: { type: 'string', example: '750.00' },
    },
  },
  DailyCollectionResponse: envelope('DailyCollection'),
};

export const operations = {
  'GET /api/v1/admin/ledger/trial-balance': { response: 'TrialBalanceResponse' },
  'GET /api/v1/admin/ledger/ar-aging': { response: 'AgingReportResponse' },
  'GET /api/v1/admin/ledger/insurer-aging': { response: 'AgingReportResponse' },
  'GET /api/v1/admin/ledger/cash-position': { response: 'CashPositionResponse' },
  'GET /api/v1/admin/ledger/daily-collection': { response: 'DailyCollectionResponse' },
};
