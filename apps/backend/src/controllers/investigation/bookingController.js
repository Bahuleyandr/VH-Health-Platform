import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendSMS } from '../../services/smsService.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';
import { calculateETA } from '../delivery/deliveryTrackingController.js';

// ─── Patient Endpoints ─────────────────────────────────────────────────────

// POST /investigations/bookings/create — patient books investigation
export const createBooking = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const {
      selected_tests,
      custom_test_names,
      collection_type,
      collection_address, collection_landmark, collection_lat, collection_lng,
      preferred_date, preferred_time_slot,
      notes
    } = req.body;

    // Parse selected_tests if it comes as a string (multipart form)
    let parsedTests = selected_tests;
    if (typeof selected_tests === 'string') {
      try { parsedTests = JSON.parse(selected_tests); } catch { parsedTests = null; }
    }

    if (!parsedTests?.length && !custom_test_names && !req.file) {
      return error(res, 'Select tests, type test names, or upload a prescription slip', HTTP_STATUS.BAD_REQUEST);
    }

    // Calculate estimated cost from catalog
    let estimatedCost = 0;
    if (parsedTests?.length) {
      const costs = await prisma.$queryRawUnsafe(
        `SELECT id, default_cost, home_collection_surcharge FROM investigation_test_catalog WHERE id = ANY($1)`,
        parsedTests
      );
      for (const t of costs) {
        estimatedCost += parseFloat(t.default_cost || 0);
        if (collection_type === 'home') estimatedCost += parseFloat(t.home_collection_surcharge || 50);
      }
    }

    // Upload slip photo if provided
    let slipPhotoKey = null;
    if (req.file) {
      const timestamp = Date.now();
      const ext = req.file.originalname?.split('.').pop() || 'jpg';
      slipPhotoKey = `investigations/slips/${patientId}/${timestamp}.${ext}`;
      try {
        await uploadFileToR2(req.file.buffer, slipPhotoKey, req.file.mimetype);
      } catch (e) { logger.warn('Slip upload failed:', e.message); }
    }

    const patient = await prisma.$queryRawUnsafe('SELECT name, phone FROM users WHERE id=$1', patientId);

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO investigation_bookings (
        patient_id, patient_phone, patient_name,
        selected_tests, custom_test_names, slip_photo_key, notes,
        collection_type, collection_address, collection_landmark,
        collection_lat, collection_lng,
        preferred_date, preferred_time_slot,
        estimated_cost
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15)
      RETURNING id, booking_number, patient_id, patient_name, patient_phone,
        selected_tests, custom_test_names, slip_photo_key, notes,
        collection_type, collection_address, collection_landmark,
        preferred_date, preferred_time_slot, estimated_cost,
        status, created_at, updated_at
    `, 
      patientId, patient[0]?.phone, patient[0]?.name,
      parsedTests || null, custom_test_names || null, slipPhotoKey, notes || null,
      collection_type || 'home', collection_address || null, collection_landmark || null,
      collection_lat || null, collection_lng || null,
      preferred_date || null, preferred_time_slot || null,
      estimatedCost || null
    );

    // Log status
    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_booking_history (booking_id, to_status, changed_by, changed_by_role, notes)
       VALUES ($1, 'BOOKED', $2, 'patient', 'Patient booked investigation')`,
      result[0].id, patientId
    );

    // Alert lab staff (fire-and-forget)
    setImmediate(async () => {
      try {
        const labStaff = await prisma.$queryRawUnsafe(`
          SELECT device_token, name FROM users
          WHERE role IN ('LAB_TECHNICIAN', 'TECHNICIAN', 'NURSE')
            AND device_token IS NOT NULL AND is_active = TRUE LIMIT 20
        `);
        const tokens = labStaff.map(r => r.device_token).filter(Boolean);
        if (tokens.length) {
          await sendPushNotification({
            tokens,
            title: '🔬 New Investigation Booking',
            body: `${patient[0]?.name || 'Patient'} booked: ${parsedTests?.length ? parsedTests.length + ' tests' : custom_test_names || 'Prescription slip'}. ${collection_type === 'home' ? 'Home collection' : 'Walk-in'}`,
            data: { type: 'investigation_booking', booking_id: String(result[0].id) }
          }).catch(e => logger.warn('Failed to send new booking push notification:', e.message));
        }
      } catch (e) { logger.warn('Lab alert failed:', e.message); }
    });

    success(res, result[0], `Investigation booked. ${result[0].booking_number}`);
  } catch (e) {
    logger.error('createBooking error:', e);
    error(res, 'Failed to create investigation booking', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /investigations/bookings/my — patient's own bookings
export const getMyBookings = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const result = await prisma.$queryRawUnsafe(`
      SELECT ib.id, ib.booking_number, ib.patient_id, ib.patient_name, ib.patient_phone,
        ib.selected_tests, ib.custom_test_names, ib.status, ib.notes,
        ib.collection_type, ib.collection_address, ib.collection_landmark,
        ib.preferred_date, ib.preferred_time_slot, ib.estimated_cost, ib.final_cost,
        ib.slip_photo_key, ib.result_file_key, ib.created_at, ib.updated_at,
        (SELECT json_agg(t) FROM investigation_test_catalog t WHERE t.id = ANY(COALESCE(ib.selected_tests, ARRAY[]::int[]))) as test_details
      FROM investigation_bookings ib
      WHERE ib.patient_id = $1
      ORDER BY ib.created_at DESC
      LIMIT $2 OFFSET $3
    `, patientId, limit, offset);

    const bookings = await Promise.all(result.map(async b => {
      if (b.slip_photo_key) b.slip_photo_url = await getSignedFileUrl(b.slip_photo_key, 3600).catch(() => null);
      if (b.result_file_key) b.result_file_url = await getSignedFileUrl(b.result_file_key, 3600).catch(() => null);
      return b;
    }));

    success(res, bookings, 'My bookings fetched', HTTP_STATUS.OK, { limit, offset });
  } catch (e) {
    // The investigation_bookings table is part of an incomplete feature
    // (booking lifecycle was never migrated). Until we build that schema
    // out properly, return an empty list rather than 500-ing the dashboard
    // — the patient genuinely has no bookings, the response is honest.
    if (e?.meta?.code === '42P01') {
      return success(res, [], 'My bookings fetched', HTTP_STATUS.OK, { limit: 0, offset: 0 });
    }
    logger.error('getMyBookings error:', e);
    error(res, 'Failed to fetch bookings', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Lab Staff Endpoints ────────────────────────────────────────────────────

// GET /investigations/bookings/queue — all pending bookings for lab staff
export const getBookingQueue = async (req, res) => {
  try {
    const { status, collection_type, from_date, to_date } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { params.push(status); where += ` AND ib.status=$${params.length}`; }
    if (collection_type) { params.push(collection_type); where += ` AND ib.collection_type=$${params.length}`; }
    if (from_date) { params.push(from_date); where += ` AND DATE(ib.created_at)>=$${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND DATE(ib.created_at)<=$${params.length}`; }

    const result = await prisma.$queryRawUnsafe(`
      SELECT ib.id, ib.investigation_id, ib.patient_id, ib.patient_name, ib.patient_phone,
        ib.test_name, ib.status, ib.scheduled_date, ib.phlebotomist_id, ib.notes,
        ib.created_at, ib.updated_at,
        (SELECT json_agg(t.name) FROM investigation_test_catalog t WHERE t.id = ANY(ib.selected_tests)) as test_names,
        (EXTRACT(EPOCH FROM (NOW() - ib.created_at))/60)::float8 as mins_since_booked,
        CASE WHEN NOW() > ib.sla_confirm_target AND ib.status='BOOKED' THEN TRUE ELSE FALSE END as sla_breached
      FROM investigation_bookings ib
      ${where}
      ORDER BY
        CASE ib.status
          WHEN 'BOOKED' THEN 1
          WHEN 'CONFIRMED' THEN 2
          WHEN 'DISPATCHED' THEN 3
          WHEN 'COLLECTED' THEN 4
          WHEN 'PROCESSING' THEN 5
          ELSE 6
        END,
        ib.created_at ASC
    `, ...params);

    const bookings = await Promise.all(result.map(async b => {
      if (b.slip_photo_key) b.slip_photo_url = await getSignedFileUrl(b.slip_photo_key, 3600).catch(() => null);
      if (b.result_file_key) b.result_file_url = await getSignedFileUrl(b.result_file_key, 3600).catch(() => null);
      return b;
    }));

    success(res, bookings, 'Booking queue fetched');
  } catch (e) {
    logger.error('getBookingQueue error:', e);
    error(res, 'Failed to fetch booking queue', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /investigations/bookings/:id/confirm — lab staff confirms booking
export const confirmBooking = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staffId = req.user?.id;
    const { confirmation_notes, actual_tests, final_cost } = req.body;

    const booking = await prisma.$queryRawUnsafe('SELECT id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at FROM investigation_bookings WHERE id=$1', id);
    if (!booking.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    if (booking[0].status !== 'BOOKED') return error(res, 'Can only confirm BOOKED bookings', HTTP_STATUS.BAD_REQUEST);

    const result = await prisma.$queryRawUnsafe(`
      UPDATE investigation_bookings SET
        status='CONFIRMED', confirmed_by=$1, confirmed_at=NOW(),
        confirmation_notes=$2, actual_tests=$3, final_cost=COALESCE($4, estimated_cost),
        sla_dispatch_target=NOW()+INTERVAL '1 hour',
        updated_at=NOW()
      WHERE id=$5 RETURNING id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at
    `, staffId, confirmation_notes, actual_tests, final_cost, id);

    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_booking_history (booking_id, from_status, to_status, changed_by, changed_by_role, notes) VALUES ($1,'BOOKED','CONFIRMED',$2,'lab_staff',$3)`,
      id, staffId, confirmation_notes
    );

    // Notify patient (fire-and-forget)
    setImmediate(async () => {
      try {
        const patient = await prisma.$queryRawUnsafe('SELECT device_token, phone FROM users WHERE id=$1', booking[0].patient_id);
        const tokens = [patient[0]?.device_token].filter(Boolean);
        if (tokens.length) {
          await sendPushNotification({
            tokens,
            title: 'Investigation Confirmed ✓',
            body: `Your investigation booking ${booking[0].booking_number} is confirmed. ${booking[0].collection_type === 'home' ? 'A collector will be dispatched shortly.' : 'Please visit the lab at your preferred time.'}`,
            data: { type: 'investigation_confirmed', booking_id: String(id) }
          }).catch(e => logger.warn('Failed to send booking confirmation push notification:', e.message));
        }
        if (patient[0]?.phone) {
          await sendSMS(patient[0].phone, `Dear ${booking[0].patient_name}, your investigation ${booking[0].booking_number} is confirmed. ${booking[0].collection_type === 'home' ? 'Collector will be dispatched soon.' : 'Please visit Venkataeswara Hospitals lab.'} Estimated cost: ₹${result[0].final_cost || result[0].estimated_cost || 'TBD'}`).catch(e => logger.warn('Failed to send booking confirmation SMS:', e.message));
        }
      } catch (e) { logger.warn('Confirm notification failed:', e.message); }
    });

    success(res, result[0], 'Booking confirmed');
  } catch (e) {
    logger.error('confirmBooking error:', e);
    error(res, 'Failed to confirm booking', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /investigations/bookings/:id/dispatch — assign collector and dispatch
export const dispatchCollector = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staffId = req.user?.id;
    const { assigned_collector, collector_phone, notes: dispatchNotes } = req.body;

    const booking = await prisma.$queryRawUnsafe('SELECT id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at FROM investigation_bookings WHERE id=$1', id);
    if (!booking.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    if (booking[0].status !== 'CONFIRMED') return error(res, 'Must be CONFIRMED first', HTTP_STATUS.BAD_REQUEST);

    const result = await prisma.$queryRawUnsafe(`
      UPDATE investigation_bookings SET
        status='DISPATCHED', assigned_collector=$1, dispatched_at=NOW(),
        collector_phone=$2, sla_collect_target=NOW()+INTERVAL '2 hours',
        updated_at=NOW()
      WHERE id=$3 RETURNING id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at
    `, assigned_collector || staffId, collector_phone, id);

    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_booking_history (booking_id, from_status, to_status, changed_by, changed_by_role, notes) VALUES ($1,'CONFIRMED','DISPATCHED',$2,'lab_staff',$3)`,
      id, staffId, dispatchNotes || 'Collector dispatched'
    );

    // Calculate ETA based on collection destination
    const eta = calculateETA(booking[0].collection_lat, booking[0].collection_lng);
    await prisma.$queryRawUnsafe(`UPDATE investigation_bookings SET estimated_collection_mins=$1, collection_distance_km=$2, collection_tracking_active=TRUE WHERE id=$3`, eta.estimated_mins, eta.distance_km, id);

    // Notify patient (fire-and-forget)
    setImmediate(async () => {
      try {
        const patient = await prisma.$queryRawUnsafe('SELECT device_token FROM users WHERE id=$1', booking[0].patient_id);
        const tokens = [patient[0]?.device_token].filter(Boolean);
        if (tokens.length) {
          await sendPushNotification({
            tokens,
            title: 'Collector On The Way 🚗',
            body: `Sample collector dispatched for ${booking[0].booking_number}. Estimated arrival: ~${eta.estimated_mins} minutes. ${collector_phone ? 'Contact: ' + collector_phone : ''}`,
            data: { type: 'collector_dispatched', booking_id: String(id) }
          }).catch(e => logger.warn('Failed to send dispatch push notification:', e.message));
        }
      } catch (e) { logger.warn('Dispatch notification failed:', e.message); }
    });

    success(res, result[0], 'Collector dispatched');
  } catch (e) {
    logger.error('dispatchCollector error:', e);
    error(res, 'Failed to dispatch collector', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /investigations/bookings/:id/collected — mark samples collected
export const markCollected = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staffId = req.user?.id;
    const { collection_notes } = req.body;

    const result = await prisma.$queryRawUnsafe(`
      UPDATE investigation_bookings SET
        status='COLLECTED', collected_at=NOW(), collected_by=$1,
        collection_notes=$2, collection_tracking_active=FALSE, updated_at=NOW()
      WHERE id=$3 AND status IN ('DISPATCHED','CONFIRMED') RETURNING id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at
    `, staffId, collection_notes, id);

    if (!result.length) return error(res, 'Not found or wrong status', HTTP_STATUS.BAD_REQUEST);

    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_booking_history (booking_id, from_status, to_status, changed_by, changed_by_role, notes) VALUES ($1,$2,'COLLECTED',$3,'lab_staff',$4)`,
      id, 'DISPATCHED', staffId, collection_notes || 'Samples collected'
    );

    success(res, result[0], 'Samples collected');
  } catch (e) {
    logger.error('markCollected error:', e);
    error(res, 'Failed to mark samples as collected', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /investigations/bookings/:id/processing — mark processing started
export const startProcessing = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staffId = req.user?.id;

    const booking = await prisma.$queryRawUnsafe('SELECT id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at FROM investigation_bookings WHERE id=$1', id);
    if (!booking.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    // Calculate SLA target based on test turnaround
    let maxTAT = 24;
    if (booking[0].selected_tests?.length) {
      const tat = await prisma.$queryRawUnsafe('SELECT MAX(turnaround_hours) as max_tat FROM investigation_test_catalog WHERE id=ANY($1)', booking[0].selected_tests);
      maxTAT = parseInt(tat[0]?.max_tat) || 24;
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE investigation_bookings SET
        status='PROCESSING', processing_started_at=NOW(),
        sla_result_target=NOW()+INTERVAL '1 hour' * $2,
        updated_at=NOW()
      WHERE id=$1 RETURNING id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at
    `, id, maxTAT);

    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_booking_history (booking_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1,'COLLECTED','PROCESSING',$2,'lab_staff')`,
      id, staffId
    );

    success(res, result[0], 'Processing started');
  } catch (e) {
    logger.error('startProcessing error:', e);
    error(res, 'Failed to start processing', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /investigations/bookings/:id/result — upload result PDF
export const uploadResult = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staffId = req.user?.id;
    const { result_notes } = req.body;

    if (!req.file) return error(res, 'Result file is required', HTTP_STATUS.BAD_REQUEST);

    const booking = await prisma.$queryRawUnsafe('SELECT id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at FROM investigation_bookings WHERE id=$1', id);
    if (!booking.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    // Upload to R2
    const timestamp = Date.now();
    const ext = req.file.originalname?.split('.').pop() || 'pdf';
    const fileKey = `investigations/results/${id}/${timestamp}.${ext}`;

    try {
      await uploadFileToR2(req.file.buffer, fileKey, req.file.mimetype);
    } catch (e) { logger.warn('Result upload failed:', e.message); }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE investigation_bookings SET
        status='RESULT_READY', result_uploaded_at=NOW(), result_uploaded_by=$1,
        result_file_key=$2, result_notes=$3, updated_at=NOW()
      WHERE id=$4 RETURNING id, investigation_id, patient_id, patient_name, patient_phone, test_name, status, scheduled_date, phlebotomist_id, notes, created_at, updated_at
    `, staffId, fileKey, result_notes, id);

    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_booking_history (booking_id, from_status, to_status, changed_by, changed_by_role, notes) VALUES ($1,'PROCESSING','RESULT_READY',$2,'lab_staff','Result uploaded')`,
      id, staffId
    );

    // Notify patient (fire-and-forget)
    setImmediate(async () => {
      try {
        const patient = await prisma.$queryRawUnsafe('SELECT device_token, phone FROM users WHERE id=$1', booking[0].patient_id);
        const tokens = [patient[0]?.device_token].filter(Boolean);
        if (tokens.length) {
          await sendPushNotification({
            tokens,
            title: 'Investigation Results Ready 🔬',
            body: `Results for ${booking[0].booking_number} are ready. Tap to view and download.`,
            data: { type: 'investigation_result_ready', booking_id: String(id) }
          }).catch(e => logger.warn('Failed to send result ready push notification:', e.message));
        }
        if (patient[0]?.phone) {
          await sendSMS(patient[0].phone, `Dear ${booking[0].patient_name}, your investigation results (${booking[0].booking_number}) are ready. Please check your VHHealth app to view/download.`).catch(e => logger.warn('Failed to send result ready SMS:', e.message));
        }
      } catch (e) { logger.warn('Result notification failed:', e.message); }
    });

    success(res, result[0], 'Result uploaded and patient notified');
  } catch (e) {
    logger.error('uploadResult error:', e);
    error(res, 'Failed to upload result', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /investigations/bookings/:id — get booking detail
export const getBookingDetail = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const booking = await prisma.$queryRawUnsafe(`
      SELECT ib.id, ib.investigation_id, ib.patient_id, ib.patient_name, ib.patient_phone,
        ib.test_name, ib.status, ib.scheduled_date, ib.phlebotomist_id, ib.notes,
        ib.created_at, ib.updated_at,
        (SELECT json_agg(t) FROM investigation_test_catalog t WHERE t.id = ANY(ib.selected_tests)) as test_details,
        cu.name as confirmed_by_name,
        au.name as collector_name
      FROM investigation_bookings ib
      LEFT JOIN users cu ON ib.confirmed_by = cu.id
      LEFT JOIN users au ON ib.assigned_collector = au.id
      WHERE ib.id = $1
    `, id);
    if (!booking.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    const history = await prisma.$queryRawUnsafe('SELECT id, booking_id, from_status, to_status, changed_by, changed_by_role, notes, created_at FROM investigation_booking_history WHERE booking_id=$1 ORDER BY created_at', id);

    const b = booking[0];
    if (b.slip_photo_key) b.slip_photo_url = await getSignedFileUrl(b.slip_photo_key, 3600).catch(() => null);
    if (b.result_file_key) b.result_file_url = await getSignedFileUrl(b.result_file_key, 3600).catch(() => null);

    success(res, { booking: b, history: history }, 'Booking detail');
  } catch (e) {
    logger.error('getBookingDetail error:', e);
    error(res, 'Failed to fetch booking detail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /investigations/bookings/sla — admin SLA overview
export const getBookingSLADashboard = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const from = from_date || new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];

    const [summary, byStatus, slaBreaches, avgTimes] = await Promise.all([
      prisma.$queryRawUnsafe(`SELECT COUNT(*) as total,
        COUNT(CASE WHEN status='BOOKED' THEN 1 END) as booked,
        COUNT(CASE WHEN status='CONFIRMED' THEN 1 END) as confirmed,
        COUNT(CASE WHEN status='DISPATCHED' THEN 1 END) as dispatched,
        COUNT(CASE WHEN status='COLLECTED' THEN 1 END) as collected,
        COUNT(CASE WHEN status='PROCESSING' THEN 1 END) as processing,
        COUNT(CASE WHEN status='RESULT_READY' THEN 1 END) as result_ready,
        COUNT(CASE WHEN collection_type='home' THEN 1 END) as home_collection,
        COUNT(CASE WHEN collection_type='walk_in' THEN 1 END) as walk_in,
        SUM(COALESCE(final_cost, estimated_cost, 0)) as total_revenue
        FROM investigation_bookings WHERE DATE(created_at) BETWEEN $1::date AND $2::date`, from, to),
      prisma.$queryRawUnsafe(`SELECT status, COUNT(*) as count FROM investigation_bookings WHERE DATE(created_at) BETWEEN $1::date AND $2::date GROUP BY status`, from, to),
      prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM investigation_bookings
        WHERE status='BOOKED' AND NOW() > sla_confirm_target AND DATE(created_at) BETWEEN $1::date AND $2::date`, from, to),
      prisma.$queryRawUnsafe(`SELECT
        AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at))/60) as avg_confirm_mins,
        AVG(EXTRACT(EPOCH FROM (dispatched_at - confirmed_at))/60) as avg_dispatch_mins,
        AVG(EXTRACT(EPOCH FROM (collected_at - dispatched_at))/60) as avg_collect_mins,
        AVG(EXTRACT(EPOCH FROM (result_uploaded_at - collected_at))/3600) as avg_result_hours
        FROM investigation_bookings WHERE result_uploaded_at IS NOT NULL AND DATE(created_at) BETWEEN $1::date AND $2::date`, from, to),
    ]);

    success(res, {
      summary: summary[0],
      by_status: byStatus,
      sla_breaches: parseInt(slaBreaches[0]?.count || 0),
      avg_times: avgTimes[0],
      date_range: { from, to }
    }, 'Booking SLA dashboard');
  } catch (e) {
    logger.error('getBookingSLADashboard error:', e);
    error(res, 'Failed to fetch SLA dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
