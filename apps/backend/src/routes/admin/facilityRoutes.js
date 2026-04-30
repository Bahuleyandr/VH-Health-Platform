/**
 * Admin routes for Facility / Location / Room / ServiceCatalog (Phase C1).
 *
 * Mounted at /api/v1/admin/facilities via routes/admin/index.js.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  getDefaultFacility,
  listFacilities,
  listLocations,
  listRooms,
  listServices,
  seedDefaultFacilityForTenant,
  upsertFacility,
  upsertLocation,
  upsertRoom,
  upsertService,
} from '../../services/facility/facilityService.js';

const router = express.Router();

// Facilities
router.put('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertFacility({
      tenantId: req.tenantId,
      id: b.id,
      facilityCode: b.facility_code,
      displayName: b.display_name,
      facilityKind: b.facility_kind,
      legalEntityName: b.legal_entity_name,
      registrationNumber: b.registration_number,
      addressLine1: b.address_line1,
      addressLine2: b.address_line2,
      city: b.city,
      state: b.state,
      country: b.country,
      postalCode: b.postal_code,
      timezone: b.timezone,
      phone: b.phone,
      email: b.email,
      status: b.status,
      isDefault: b.is_default,
      geoLat: b.geo_lat,
      geoLng: b.geo_lng,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Facility saved');
  } catch (err) { return next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const result = await listFacilities({
      tenantId: req.tenantId,
      status: req.query.status || null,
      facilityKind: req.query.facility_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Facilities retrieved');
  } catch (err) { return next(err); }
});

router.get('/default', async (req, res, next) => {
  try {
    const row = await getDefaultFacility({ tenantId: req.tenantId });
    return success(res, row, 'Default facility retrieved');
  } catch (err) { return next(err); }
});

router.post('/seed-default', async (req, res, next) => {
  try {
    const row = await seedDefaultFacilityForTenant({
      tenantId: req.tenantId,
      fallbackName: req.body?.fallback_name,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Default facility ensured');
  } catch (err) { return next(err); }
});

// Locations
router.put('/locations', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertLocation({
      tenantId: req.tenantId,
      id: b.id,
      facilityId: b.facility_id,
      parentId: b.parent_id,
      locationCode: b.location_code,
      displayName: b.display_name,
      locationKind: b.location_kind,
      floor: b.floor,
      building: b.building,
      status: b.status,
      capacityHint: b.capacity_hint,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Location saved');
  } catch (err) { return next(err); }
});

router.get('/locations', async (req, res, next) => {
  try {
    const parentIdQuery = req.query.parent_id;
    let parentId;
    if (parentIdQuery !== undefined) {
      parentId = parentIdQuery === '' || parentIdQuery === 'null' ? null : parentIdQuery;
    }
    const result = await listLocations({
      tenantId: req.tenantId,
      facilityId: req.query.facility_id || null,
      locationKind: req.query.location_kind || null,
      status: req.query.status || null,
      parentId,
      limit: req.query.limit,
    });
    return success(res, result, 'Locations retrieved');
  } catch (err) { return next(err); }
});

// Rooms
router.put('/rooms', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertRoom({
      tenantId: req.tenantId,
      id: b.id,
      facilityId: b.facility_id,
      locationId: b.location_id,
      roomCode: b.room_code,
      displayName: b.display_name,
      roomKind: b.room_kind,
      bedCapacity: b.bed_capacity,
      floor: b.floor,
      status: b.status,
      metadata: b.metadata,
    });
    return success(res, row, 'Room saved');
  } catch (err) { return next(err); }
});

router.get('/rooms', async (req, res, next) => {
  try {
    const result = await listRooms({
      tenantId: req.tenantId,
      facilityId: req.query.facility_id || null,
      locationId: req.query.location_id || null,
      roomKind: req.query.room_kind || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Rooms retrieved');
  } catch (err) { return next(err); }
});

// Service catalog
router.put('/services', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertService({
      tenantId: req.tenantId,
      id: b.id,
      facilityId: b.facility_id,
      serviceCode: b.service_code,
      displayName: b.display_name,
      description: b.description,
      serviceKind: b.service_kind,
      specialty: b.specialty,
      departmentId: b.department_id,
      defaultDurationMinutes: b.default_duration_minutes,
      requiresAppointment: b.requires_appointment,
      isTelehealthEligible: b.is_telehealth_eligible,
      defaultTariffItemCode: b.default_tariff_item_code,
      status: b.status,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Service saved');
  } catch (err) { return next(err); }
});

router.get('/services', async (req, res, next) => {
  try {
    const result = await listServices({
      tenantId: req.tenantId,
      facilityId: req.query.facility_id || null,
      serviceKind: req.query.service_kind || null,
      specialty: req.query.specialty || null,
      status: req.query.status || null,
      telehealthEligible: req.query.telehealth_eligible != null ? req.query.telehealth_eligible === 'true' : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Services retrieved');
  } catch (err) { return next(err); }
});

export default router;
