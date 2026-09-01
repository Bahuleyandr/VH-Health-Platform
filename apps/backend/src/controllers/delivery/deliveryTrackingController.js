import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// Hospital location
const HOSPITAL_LAT = parseFloat(process.env.HOSPITAL_LAT || '13.02936');
const HOSPITAL_LNG = parseFloat(process.env.HOSPITAL_LNG || '80.24409');
const ORDER_TYPES = new Set(['pharmacy', 'investigation']);
const ADMIN_DELIVERY_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const PHARMACY_DELIVERY_ROLES = new Set(['PHARMACY_STAFF', 'PHARMACY_INCHARGE']);
const DELIVERY_ACTOR_ROLES = new Set(['DELIVERY_STAFF', 'DRIVER', 'GENERAL_STAFF']);

// Haversine distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Estimate delivery time: assume avg 15 km/h in Chennai traffic
function estimateMinutes(distanceKm) {
  const avgSpeedKmh = 15;
  return Math.max(10, Math.ceil((distanceKm / avgSpeedKmh) * 60));
}

/**
 * Calculate ETA when dispatching — called internally from dispatch handlers
 */
export function calculateETA(destLat, destLng) {
  const distance = haversineKm(HOSPITAL_LAT, HOSPITAL_LNG, destLat || HOSPITAL_LAT, destLng || HOSPITAL_LNG);
  const minutes = estimateMinutes(distance);
  return { distance_km: Math.round(distance * 100) / 100, estimated_mins: minutes };
}

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function samePhone(left, right) {
  const normalizedLeft = normalizePhone(left || '');
  const normalizedRight = normalizePhone(right || '');
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizeOrderType(value) {
  const orderType = String(value || '').trim().toLowerCase();
  return ORDER_TYPES.has(orderType) ? orderType : null;
}

function isAdminDeliveryUser(user) {
  return ADMIN_DELIVERY_ROLES.has(normalizeRole(user?.role));
}

function isPharmacyDeliveryUser(user) {
  return PHARMACY_DELIVERY_ROLES.has(normalizeRole(user?.role));
}

function isAssignedDeliveryUser(order, user) {
  return (
    sameId(order?.delivery_assignee_uid, user?.uid)
    || sameId(order?.dispatched_by, user?.id)
    || sameId(order?.assigned_collector, user?.id)
    || sameId(order?.phlebotomist_id, user?.id)
    || sameId(order?.collected_by, user?.id)
    || samePhone(order?.delivery_person_phone, user?.phone)
  );
}

export function canReadDeliveryTracking(order, user, orderType) {
  const role = normalizeRole(user?.role);
  if (isAdminDeliveryUser(user)) return true;
  if (orderType === 'pharmacy' && isPharmacyDeliveryUser(user)) return true;
  if (role === 'PATIENT') {
    return (
      sameId(order?.uid, user?.uid)
      || sameId(order?.patient_uid, user?.uid)
      || sameId(order?.patient_id, user?.id)
      || samePhone(order?.phone, user?.phone)
      || samePhone(order?.patient_phone, user?.phone)
    );
  }
  if (orderType === 'pharmacy') {
    return role === 'DELIVERY_STAFF'
      && sameId(order?.delivery_assignee_uid, user?.uid);
  }
  return DELIVERY_ACTOR_ROLES.has(role) && isAssignedDeliveryUser(order, user);
}

export function canManageDeliveryTracking(order, user, orderType) {
  const role = normalizeRole(user?.role);
  if (orderType === 'pharmacy') {
    return role === 'DELIVERY_STAFF'
      && sameId(order?.delivery_assignee_uid, user?.uid);
  }
  if (isAdminDeliveryUser(user)) return true;
  return DELIVERY_ACTOR_ROLES.has(role) && isAssignedDeliveryUser(order, user);
}

async function loadDeliveryOrder(orderType, orderId, tenantId) {
  if (orderType === 'pharmacy') {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT id, order_number, status, delivery_lat, delivery_lng,
             estimated_delivery_mins, delivery_distance_km,
             delivery_tracking_active, delivery_person,
             delivery_person_phone, dispatched_at,
             uid, patient_id, phone, patient_phone, tenant_id, dispatched_by,
             facility_id, delivery_assignee_uid, delivery_handoff_generation,
             delivery_custody_status, delivery_handoff_consumed_at
        FROM pharmacy_orders
       WHERE id = $1 AND tenant_id = $2::uuid
       LIMIT 1
    `, orderId, tenantId);
    return rows[0] || null;
  }

  if (orderType === 'investigation') {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT ib.id, ib.booking_number AS order_number, ib.status,
             ib.collector_lat AS delivery_lat, ib.collector_lng AS delivery_lng,
             ib.estimated_collection_mins AS estimated_delivery_mins,
             ib.collection_distance_km AS delivery_distance_km,
             ib.collection_tracking_active AS delivery_tracking_active,
             NULL::text AS delivery_person,
             ib.collector_phone AS delivery_person_phone,
             ib.dispatched_at, ib.patient_id, ib.patient_phone, ib.tenant_id,
             ib.phlebotomist_id, ib.assigned_collector, ib.collected_by,
             u.uid AS patient_uid,
             u.phone AS phone
        FROM investigation_bookings ib
        LEFT JOIN users u ON u.id = ib.patient_id
       WHERE ib.id = $1 AND ib.tenant_id = $2::uuid
       LIMIT 1
    `, orderId, tenantId);
    return rows[0] || null;
  }

  return null;
}

function hasValidLocation(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

function optionalFinite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function hasActivePharmacyDeliveryGrant(order, user, tenantId) {
  if (normalizeRole(user?.role) !== 'DELIVERY_STAFF'
      || !sameId(order?.delivery_assignee_uid, user?.uid)) return false;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM pharmacy_staff_facility_grants facility_grant
      WHERE facility_grant.tenant_id=$1::uuid
        AND facility_grant.facility_id=$2::int
        AND facility_grant.staff_uid=$3::uuid
        AND facility_grant.status='active'
        AND facility_grant.revoked_at IS NULL
      LIMIT 1`,
    tenantId,
    Number(order.facility_id),
    String(user.uid),
  );
  return rows.length === 1;
}

/**
 * POST /delivery/location-update — delivery person sends GPS update
 */
export const updateDeliveryLocation = async (req, res) => {
  try {
    const deliveryPersonId = req.user?.id;
    if (!deliveryPersonId) {
      return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);
    }

    // Verify the user has a delivery-capable role
    if (![...DELIVERY_ACTOR_ROLES, ...ADMIN_DELIVERY_ROLES, ...PHARMACY_DELIVERY_ROLES].includes(normalizeRole(req.user?.role))) {
      return error(res, 'Only delivery staff can update delivery location', HTTP_STATUS.FORBIDDEN);
    }

    const { order_type, order_id, lat, lng, accuracy, speed, heading, battery_level } = req.body;
    const orderType = normalizeOrderType(order_type);

    if (!orderType || !order_id || !hasValidLocation(lat, lng)) {
      return error(res, 'order_type, order_id, lat, lng required', HTTP_STATUS.BAD_REQUEST);
    }

    const order = await loadDeliveryOrder(orderType, order_id, tenantOf(req));
    if (!order) {
      return error(res, 'Delivery order not found', HTTP_STATUS.NOT_FOUND);
    }
    if (!canManageDeliveryTracking(order, req.user, orderType)) {
      return error(res, 'Delivery tracking access denied', HTTP_STATUS.FORBIDDEN);
    }

    if (orderType === 'pharmacy') {
      const tenantId = tenantOf(req);
      const updated = await setTenantTx(tenantId, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT pharmacy_order.id, pharmacy_order.facility_id,
                  pharmacy_order.delivery_lat, pharmacy_order.delivery_lng,
                  pharmacy_order.delivery_handoff_generation
             FROM pharmacy_orders pharmacy_order
             JOIN pharmacy_staff_facility_grants facility_grant
               ON facility_grant.tenant_id=pharmacy_order.tenant_id
              AND facility_grant.facility_id=pharmacy_order.facility_id
              AND facility_grant.staff_uid=$3::uuid
              AND facility_grant.status='active'
              AND facility_grant.revoked_at IS NULL
            WHERE pharmacy_order.tenant_id=$1::uuid
              AND pharmacy_order.id=$2::int
              AND pharmacy_order.delivery_assignee_uid=$3::uuid
              AND pharmacy_order.status='DISPATCHED'
              AND pharmacy_order.delivery_custody_status='in_transit'
              AND pharmacy_order.delivery_handoff_consumed_at IS NULL
            FOR UPDATE OF pharmacy_order, facility_grant`,
          tenantId,
          Number(order_id),
          String(req.user?.uid || ''),
        );
        if (!rows[0]) return false;
        const lockedOrder = rows[0];
        const remaining = hasValidLocation(
          lockedOrder.delivery_lat,
          lockedOrder.delivery_lng,
        )
          ? haversineKm(
            Number(lat),
            Number(lng),
            Number(lockedOrder.delivery_lat),
            Number(lockedOrder.delivery_lng),
          )
          : null;
        const eta = remaining == null ? null : estimateMinutes(remaining);
        await tx.$queryRawUnsafe(
          `INSERT INTO pharmacy_delivery_location_updates
             (tenant_id, pharmacy_order_id, facility_id, delivery_assignee_uid,
              handoff_generation, latitude, longitude, accuracy_m, speed_kmh,
              heading_degrees, battery_level)
           VALUES ($1::uuid, $2::int, $3::int, $4::uuid, $5::int,
                   $6::numeric, $7::numeric, $8::numeric, $9::numeric,
                   $10::numeric, $11::numeric)`,
          tenantId,
          Number(order_id),
          Number(lockedOrder.facility_id),
          String(req.user.uid),
          Number(lockedOrder.delivery_handoff_generation),
          Number(lat),
          Number(lng),
          optionalFinite(accuracy),
          optionalFinite(speed),
          optionalFinite(heading),
          optionalFinite(battery_level),
        );
        await tx.$queryRawUnsafe(
          `UPDATE pharmacy_orders
              SET estimated_delivery_mins=$4::int,
                  delivery_distance_km=$5::numeric,
                  delivery_tracking_active=TRUE,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::int
              AND delivery_assignee_uid=$3::uuid
              AND status='DISPATCHED' AND delivery_custody_status='in_transit'`,
          tenantId,
          Number(order_id),
          String(req.user.uid),
          eta,
          remaining == null ? null : Math.round(remaining * 100) / 100,
        );
        return true;
      });
      if (!updated) {
        return error(res, 'Delivery tracking access denied', HTTP_STATUS.FORBIDDEN);
      }
    } else if (orderType === 'investigation') {
      const existingAssignment = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT delivery_person_id FROM delivery_location_updates
         WHERE order_type = $1 AND order_id = $2 AND delivery_person_id IS NOT NULL
         ORDER BY delivery_person_id LIMIT 1`, orderType, order_id);
      if (existingAssignment.length > 0
          && String(existingAssignment[0].delivery_person_id) !== String(deliveryPersonId)
          && !isAdminDeliveryUser(req.user)) {
        return error(res, 'Another delivery person is assigned to this order', HTTP_STATUS.FORBIDDEN);
      }
      await prisma.$queryRawUnsafe(`
        INSERT INTO delivery_location_updates (order_type, order_id, delivery_person_id, lat, lng, accuracy, speed, heading, battery_level)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, orderType, order_id, deliveryPersonId, lat, lng,
      optionalFinite(accuracy), optionalFinite(speed), optionalFinite(heading), optionalFinite(battery_level));
      if (order.delivery_lat) {
        const remaining = haversineKm(lat, lng, order.delivery_lat, order.delivery_lng);
        const eta = estimateMinutes(remaining);
        await prisma.$queryRawUnsafe(`UPDATE investigation_bookings SET collector_lat=$1, collector_lng=$2, estimated_collection_mins=$3, collection_distance_km=$4, collection_tracking_active=TRUE, updated_at=NOW() WHERE id=$5 AND tenant_id=$6::uuid`,
          lat, lng, eta, Math.round(remaining * 100) / 100, order_id, tenantOf(req));
      }
    }

    success(res, { order_type: orderType, order_id, lat, lng }, 'Location updated');
  } catch (err) {
    logger.error('Delivery location update error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * GET /delivery/track/:order_type/:order_id — patient checks delivery status
 */
export const getDeliveryTracking = async (req, res) => {
  try {
    const { order_type, order_id } = req.params;
    const orderType = normalizeOrderType(order_type);
    if (!orderType || !order_id) {
      return error(res, 'Valid order_type and order_id are required', HTTP_STATUS.BAD_REQUEST);
    }

    const orderData = await loadDeliveryOrder(orderType, order_id, tenantOf(req));
    if (!orderData) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    if (!canReadDeliveryTracking(orderData, req.user, orderType)) {
      return error(res, 'Delivery tracking access denied', HTTP_STATUS.FORBIDDEN);
    }
    if (orderType === 'pharmacy'
        && normalizeRole(req.user?.role) === 'DELIVERY_STAFF'
        && !await hasActivePharmacyDeliveryGrant(orderData, req.user, tenantOf(req))) {
      return error(res, 'Delivery tracking access denied', HTTP_STATUS.FORBIDDEN);
    }

    const trail = orderType === 'pharmacy'
      ? await prisma.$queryRawUnsafe(
        `SELECT latitude AS lat, longitude AS lng, speed_kmh AS speed,
                accuracy_m AS accuracy, heading_degrees AS heading,
                handoff_generation, created_at
           FROM pharmacy_delivery_location_updates
          WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
          ORDER BY created_at DESC, id DESC LIMIT 10`,
        tenantOf(req),
        Number(order_id),
      )
      : await prisma.$queryRawUnsafe(`
        SELECT lat, lng, speed, created_at FROM delivery_location_updates
        WHERE order_type=$1 AND order_id=$2
        ORDER BY created_at DESC LIMIT 10
      `, orderType, order_id);

    success(res, {
      ...orderData,
      location_trail: trail,
      hospital_lat: HOSPITAL_LAT,
      hospital_lng: HOSPITAL_LNG,
    }, 'Tracking data');
  } catch (err) {
    logger.error('Delivery tracking fetch error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * POST /delivery/stop-tracking — delivery person stops tracking
 */
export const stopTracking = async (req, res) => {
  try {
    const { order_type, order_id } = req.body;
    const orderType = normalizeOrderType(order_type);
    if (!orderType || !order_id) {
      return error(res, 'Valid order_type and order_id are required', HTTP_STATUS.BAD_REQUEST);
    }

    const order = await loadDeliveryOrder(orderType, order_id, tenantOf(req));
    if (!order) {
      return error(res, 'Delivery order not found', HTTP_STATUS.NOT_FOUND);
    }
    if (!canManageDeliveryTracking(order, req.user, orderType)) {
      return error(res, 'Delivery tracking access denied', HTTP_STATUS.FORBIDDEN);
    }

    if (orderType === 'pharmacy') {
      const tenantId = tenantOf(req);
      const stopped = await setTenantTx(tenantId, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `UPDATE pharmacy_orders pharmacy_order
              SET delivery_tracking_active=FALSE, updated_at=NOW()
             FROM pharmacy_staff_facility_grants facility_grant
            WHERE pharmacy_order.tenant_id=$1::uuid
              AND pharmacy_order.id=$2::int
              AND pharmacy_order.delivery_assignee_uid=$3::uuid
              AND pharmacy_order.status='DISPATCHED'
              AND pharmacy_order.delivery_custody_status='in_transit'
              AND pharmacy_order.delivery_handoff_consumed_at IS NULL
              AND facility_grant.tenant_id=pharmacy_order.tenant_id
              AND facility_grant.facility_id=pharmacy_order.facility_id
              AND facility_grant.staff_uid=$3::uuid
              AND facility_grant.status='active'
              AND facility_grant.revoked_at IS NULL
          RETURNING pharmacy_order.id`,
          tenantId,
          Number(order_id),
          String(req.user?.uid || ''),
        );
        return rows.length === 1;
      });
      if (!stopped) {
        return error(res, 'Delivery tracking access denied', HTTP_STATUS.FORBIDDEN);
      }
    } else if (orderType === 'investigation') {
      await prisma.$queryRawUnsafe('UPDATE investigation_bookings SET collection_tracking_active=FALSE WHERE id=$1 AND tenant_id=$2::uuid', order_id, tenantOf(req));
    }
    success(res, { stopped: true }, 'Tracking stopped');
  } catch (err) {
    logger.error('Stop tracking error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
