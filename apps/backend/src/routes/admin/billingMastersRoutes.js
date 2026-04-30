/**
 * Admin routes for Payer / TPA / Tariff / Package master data (Phase B3).
 *
 * Mounted at /api/v1/admin/billing-masters via routes/admin/index.js.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  addPackageItem,
  linkPayerTariff,
  listPackageItems,
  listPackages,
  listPayerTariffLinks,
  listPayers,
  listTariffItems,
  listTariffPlans,
  listTpas,
  resolveServicePrice,
  upsertPackage,
  upsertPayer,
  upsertTariffItem,
  upsertTariffPlan,
  upsertTpa,
} from '../../services/billingMasters/billingMastersService.js';

const router = express.Router();

// Payers
router.put('/payers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertPayer({
      tenantId: req.tenantId,
      id: b.id,
      payerCode: b.payer_code,
      displayName: b.display_name,
      payerKind: b.payer_kind,
      registrationNumber: b.registration_number,
      contactEmail: b.contact_email,
      contactPhone: b.contact_phone,
      address: b.address,
      status: b.status,
      ehrExternalId: b.ehr_external_id,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Payer saved');
  } catch (err) { return next(err); }
});

router.get('/payers', async (req, res, next) => {
  try {
    const result = await listPayers({
      tenantId: req.tenantId,
      status: req.query.status || null,
      payerKind: req.query.payer_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Payers retrieved');
  } catch (err) { return next(err); }
});

// TPAs
router.put('/tpas', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertTpa({
      tenantId: req.tenantId,
      id: b.id,
      tpaCode: b.tpa_code,
      displayName: b.display_name,
      parentPayerId: b.parent_payer_id,
      irdaLicenseNumber: b.irda_license_number,
      contactEmail: b.contact_email,
      contactPhone: b.contact_phone,
      address: b.address,
      status: b.status,
      ehrExternalId: b.ehr_external_id,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'TPA saved');
  } catch (err) { return next(err); }
});

router.get('/tpas', async (req, res, next) => {
  try {
    const result = await listTpas({
      tenantId: req.tenantId,
      status: req.query.status || null,
      parentPayerId: req.query.parent_payer_id || null,
      limit: req.query.limit,
    });
    return success(res, result, 'TPAs retrieved');
  } catch (err) { return next(err); }
});

// Tariff plans + items
router.put('/tariff-plans', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertTariffPlan({
      tenantId: req.tenantId,
      id: b.id,
      planCode: b.plan_code,
      displayName: b.display_name,
      description: b.description,
      isDefault: b.is_default,
      currency: b.currency,
      effectiveFrom: b.effective_from,
      effectiveTo: b.effective_to,
      status: b.status,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Tariff plan saved');
  } catch (err) { return next(err); }
});

router.get('/tariff-plans', async (req, res, next) => {
  try {
    const result = await listTariffPlans({
      tenantId: req.tenantId,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Tariff plans retrieved');
  } catch (err) { return next(err); }
});

router.put('/tariff-items', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertTariffItem({
      tenantId: req.tenantId,
      id: b.id,
      tariffPlanId: b.tariff_plan_id,
      serviceCode: b.service_code,
      serviceKind: b.service_kind,
      displayName: b.display_name,
      unitPriceMinor: b.unit_price_minor,
      unitLabel: b.unit_label,
      taxable: b.taxable,
      taxRatePct: b.tax_rate_pct,
      effectiveFrom: b.effective_from,
      effectiveTo: b.effective_to,
      metadata: b.metadata,
    });
    return success(res, row, 'Tariff item saved');
  } catch (err) { return next(err); }
});

router.get('/tariff-plans/:planId/items', async (req, res, next) => {
  try {
    const result = await listTariffItems({
      tenantId: req.tenantId,
      tariffPlanId: req.params.planId,
      serviceKind: req.query.service_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Tariff items retrieved');
  } catch (err) { return next(err); }
});

// Packages + items
router.put('/packages', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertPackage({
      tenantId: req.tenantId,
      id: b.id,
      packageCode: b.package_code,
      displayName: b.display_name,
      description: b.description,
      baseSpecialty: b.base_specialty,
      baseProcedureCode: b.base_procedure_code,
      durationDays: b.duration_days,
      fixedPriceMinor: b.fixed_price_minor,
      currency: b.currency,
      status: b.status,
      exclusionNotes: b.exclusion_notes,
      inclusionNotes: b.inclusion_notes,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Package saved');
  } catch (err) { return next(err); }
});

router.get('/packages', async (req, res, next) => {
  try {
    const result = await listPackages({
      tenantId: req.tenantId,
      status: req.query.status || null,
      baseSpecialty: req.query.base_specialty || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Packages retrieved');
  } catch (err) { return next(err); }
});

router.post('/packages/:packageId/items', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await addPackageItem({
      tenantId: req.tenantId,
      packageId: req.params.packageId,
      serviceCode: b.service_code,
      serviceKind: b.service_kind,
      displayName: b.display_name,
      quantity: b.quantity,
      unitPriceMinor: b.unit_price_minor,
      isIncluded: b.is_included,
      notes: b.notes,
      metadata: b.metadata,
    });
    return success(res, row, 'Package item added', 201);
  } catch (err) { return next(err); }
});

router.get('/packages/:packageId/items', async (req, res, next) => {
  try {
    const result = await listPackageItems({
      tenantId: req.tenantId,
      packageId: req.params.packageId,
    });
    return success(res, result, 'Package items retrieved');
  } catch (err) { return next(err); }
});

// Payer ↔ tariff links
router.post('/payer-tariff-links', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await linkPayerTariff({
      tenantId: req.tenantId,
      payerId: b.payer_id,
      tpaId: b.tpa_id,
      tariffPlanId: b.tariff_plan_id,
      isPrimary: b.is_primary,
      effectiveFrom: b.effective_from,
      effectiveTo: b.effective_to,
      status: b.status,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Payer↔tariff link created', 201);
  } catch (err) { return next(err); }
});

router.get('/payer-tariff-links', async (req, res, next) => {
  try {
    const result = await listPayerTariffLinks({
      tenantId: req.tenantId,
      payerId: req.query.payer_id || null,
      tpaId: req.query.tpa_id || null,
      tariffPlanId: req.query.tariff_plan_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Links retrieved');
  } catch (err) { return next(err); }
});

// Read helper — resolve a service price.
router.get('/resolve-price', async (req, res, next) => {
  try {
    const result = await resolveServicePrice({
      tenantId: req.tenantId,
      serviceCode: req.query.service_code,
      payerId: req.query.payer_id || null,
      tpaId: req.query.tpa_id || null,
      asOf: req.query.as_of || null,
    });
    return success(res, result, 'Price resolved');
  } catch (err) { return next(err); }
});

export default router;
