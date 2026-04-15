import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Hospital location
const HOSPITAL_LAT = parseFloat(process.env.HOSPITAL_LAT || '13.02936');
const HOSPITAL_LNG = parseFloat(process.env.HOSPITAL_LNG || '80.24409');

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
    if (!['DELIVERY_STAFF', 'GENERAL_STAFF', 'ADMIN', 'PHARMACY_STAFF'].includes(req.user?.role)) {
      return error(res, 'Only delivery staff can update delivery location', HTTP_STATUS.FORBIDDEN);
    }

    const { order_type, order_id, lat, lng, accuracy, speed, heading, battery_level } = req.body;

    if (!order_type || !order_id || !lat || !lng) {
      return error(res, 'order_type, order_id, lat, lng required', HTTP_STATUS.BAD_REQUEST);
    }

    // Verify the delivery person is assigned to this order
    // Check if someone else is already tracking this order
    const existingAssignment = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT delivery_person_id FROM delivery_location_updates
       WHERE order_type = $1 AND order_id = $2 AND delivery_person_id IS NOT NULL
       ORDER BY delivery_person_id LIMIT 1`, order_type, order_id);
    if (existingAssignment.length > 0 &&
        String(existingAssignment[0].delivery_person_id) !== String(deliveryPersonId)) {
      // A different delivery person is assigned — only ADMIN can override
      if (req.user?.role !== 'ADMIN') {
        return error(res, 'Another delivery person is assigned to this order', HTTP_STATUS.FORBIDDEN);
      }
    }

    // Save location update
    await prisma.$queryRawUnsafe(`
      INSERT INTO delivery_location_updates (order_type, order_id, delivery_person_id, lat, lng, accuracy, speed, heading, battery_level)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, order_type, order_id, deliveryPersonId, lat, lng, accuracy || null, speed || null, heading || null, battery_level || null);

    // Update live location on the order
    if (order_type === 'pharmacy') {
      const order = await prisma.$queryRawUnsafe('SELECT delivery_lat, delivery_lng FROM pharmacy_orders WHERE id=$1', order_id);
      if (order.length > 0 && order[0].delivery_lat) {
        const remaining = haversineKm(lat, lng, order[0].delivery_lat, order[0].delivery_lng);
        const eta = estimateMinutes(remaining);
        await prisma.$queryRawUnsafe(`UPDATE pharmacy_orders SET delivery_lat=$1, delivery_lng=$2, estimated_delivery_mins=$3, delivery_distance_km=$4, delivery_tracking_active=TRUE, updated_at=NOW() WHERE id=$5`,
          lat, lng, eta, Math.round(remaining * 100) / 100, order_id);
      }
    } else if (order_type === 'investigation') {
      const booking = await prisma.$queryRawUnsafe('SELECT collection_lat, collection_lng FROM investigation_bookings WHERE id=$1', order_id);
      if (booking.length > 0 && booking[0].collection_lat) {
        const remaining = haversineKm(lat, lng, booking[0].collection_lat, booking[0].collection_lng);
        const eta = estimateMinutes(remaining);
        await prisma.$queryRawUnsafe(`UPDATE investigation_bookings SET collector_lat=$1, collector_lng=$2, estimated_collection_mins=$3, collection_distance_km=$4, collection_tracking_active=TRUE, updated_at=NOW() WHERE id=$5`,
          lat, lng, eta, Math.round(remaining * 100) / 100, order_id);
      }
    }

    success(res, { order_type, order_id, lat, lng }, 'Location updated');
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

    let orderData;
    if (order_type === 'pharmacy') {
      const result = await prisma.$queryRawUnsafe(`SELECT id, order_number, status, delivery_lat, delivery_lng,
        estimated_delivery_mins, delivery_distance_km, delivery_tracking_active,
        delivery_person, delivery_person_phone, dispatched_at
        FROM pharmacy_orders WHERE id=$1`, order_id);
      orderData = result[0];
    } else if (order_type === 'investigation') {
      const result = await prisma.$queryRawUnsafe(`SELECT id, booking_number as order_number, status,
        collector_lat as delivery_lat, collector_lng as delivery_lng,
        estimated_collection_mins as estimated_delivery_mins,
        collection_distance_km as delivery_distance_km,
        collection_tracking_active as delivery_tracking_active,
        collector_phone as delivery_person_phone, dispatched_at
        FROM investigation_bookings WHERE id=$1`, order_id);
      orderData = result[0];
    }

    if (!orderData) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    // Get last 10 location updates for trail
    const trail = await prisma.$queryRawUnsafe(`
      SELECT lat, lng, speed, created_at FROM delivery_location_updates
      WHERE order_type=$1 AND order_id=$2
      ORDER BY created_at DESC LIMIT 10
    `, order_type, order_id);

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
    if (order_type === 'pharmacy') {
      await prisma.$queryRawUnsafe('UPDATE pharmacy_orders SET delivery_tracking_active=FALSE WHERE id=$1', order_id);
    } else if (order_type === 'investigation') {
      await prisma.$queryRawUnsafe('UPDATE investigation_bookings SET collection_tracking_active=FALSE WHERE id=$1', order_id);
    }
    success(res, { stopped: true }, 'Tracking stopped');
  } catch (err) {
    logger.error('Stop tracking error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
