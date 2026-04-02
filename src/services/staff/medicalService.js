import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';

export const uploadConsultation = async (data) => {
  const { 
    phone, file_key, file_name, file_type, consultation_type = 'routine',
    doctor_notes, diagnosis, treatment_plan, follow_up_date,
    vital_signs, medications_prescribed, uploadedBy, uploadedByName
  } = data;

  const result = await db.query(`
    INSERT INTO consultations (
      phone, file_key, file_name, file_type, consultation_type,
      doctor_notes, diagnosis, treatment_plan, follow_up_date,
      vital_signs, medications_prescribed, uploaded_by, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    RETURNING id, phone, file_key, file_name, file_type, consultation_type, doctor_notes, diagnosis, treatment_plan, follow_up_date, vital_signs, medications_prescribed, uploaded_by, created_at
  `, [
    phone, file_key, file_name, file_type, consultation_type,
    doctor_notes, diagnosis, treatment_plan, follow_up_date,
    vital_signs ? JSON.stringify(vital_signs) : null,
    medications_prescribed ? JSON.stringify(medications_prescribed) : null,
    uploadedBy
  ]);

  // Create notification
  await db.query(
    `INSERT INTO notifications (
      phone, title, body, type, related_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      phone,
      'New Consultation Record Available',
      `Your consultation record from ${new Date().toLocaleDateString('en-GB')} is now available for review.`,
      'consultation_uploaded',
      result.rows[0].id
    ]
  );

  // Log activity
  await db.query(
    `INSERT INTO medical_activity_logs (
      staff_uid, action, patient_phone, description,
      consultation_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      uploadedBy,
      'CONSULTATION_UPLOADED',
      phone,
      `Consultation document uploaded: ${file_name}`,
      result.rows[0].id
    ]
  );

  logger.info(`📋 Consultation uploaded by ${uploadedByName} for patient ${phone}: ${file_name}`);

  return {
    consultation: {
      ...result.rows[0],
      created_at: result.rows[0].created_at.toLocaleString('en-IN'),
      follow_up_date: result.rows[0].follow_up_date ? 
        new Date(result.rows[0].follow_up_date).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        }) : null
    },
    uploadedBy: uploadedByName,
    patientNotified: true
  };
};

export const uploadInvestigationResult = async (data) => {
  const { 
    phone, test_name, file_key, file_name, file_type,
    result_status = 'normal', lab_values, reference_ranges,
    technician_notes, reviewed_by_doctor = false,
    urgent_flag = false, uploadedBy, uploadedByName
  } = data;

  const result = await db.query(`
    INSERT INTO investigations (
      phone, test_name, file_key, file_name, file_type,
      result_status, lab_values, reference_ranges, technician_notes,
      reviewed_by_doctor, urgent_flag, uploaded_by, status, requested_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'completed', NOW())
    RETURNING id, phone, test_name, file_key, file_name, file_type, result_status, lab_values, reference_ranges, technician_notes, reviewed_by_doctor, urgent_flag, uploaded_by, status, requested_at
  `, [
    phone, test_name, file_key, file_name, file_type,
    result_status, 
    lab_values ? JSON.stringify(lab_values) : null,
    reference_ranges ? JSON.stringify(reference_ranges) : null,
    technician_notes, reviewed_by_doctor, urgent_flag, uploadedBy
  ]);

  // Create notification
  const notificationTitle = urgent_flag ? 
    '🚨 URGENT: Investigation Results Available' :
    result_status === 'critical' ?
    '⚠️ Critical Investigation Results' :
    'Investigation Results Available';

  const notificationBody = urgent_flag ?
    `URGENT: Your ${test_name} results require immediate attention. Please contact your doctor.` :
    `Your ${test_name} investigation results are now available for review.`;

  await db.query(
    `INSERT INTO notifications (
      phone, title, body, type, priority, related_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      phone, notificationTitle, notificationBody,
      'investigation_result',
      urgent_flag || result_status === 'critical' ? 'high' : 'normal',
      result.rows[0].id
    ]
  );

  // Send push notification for urgent/critical results
  if (urgent_flag || result_status === 'critical') {
    try {
      const userTokens = await db.query(
        'SELECT fcm_token FROM user_devices WHERE phone = $1 AND fcm_token IS NOT NULL',
        [phone]
      );

      if (userTokens.rows.length > 0) {
        await sendPushNotification({
          tokens: userTokens.rows.map(row => row.fcm_token),
          title: notificationTitle,
          body: notificationBody,
          data: {
            type: 'investigation_urgent',
            investigation_id: result.rows[0].id.toString(),
            test_name,
            result_status
          }
        });
      }
    } catch (pushError) {
      logger.warn('Push notification failed for investigation result:', pushError);
    }
  }

  // Log activity
  await db.query(
    `INSERT INTO medical_activity_logs (
      staff_uid, action, patient_phone, description,
      investigation_id, urgent_flag, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      uploadedBy,
      'INVESTIGATION_UPLOADED',
      phone,
      `Investigation result uploaded: ${test_name} (${result_status})`,
      result.rows[0].id,
      urgent_flag
    ]
  );

  logger.info(`🔬 Investigation result uploaded by ${uploadedByName} for patient ${phone}: ${test_name} (${result_status})`);

  return {
    investigation: {
      ...result.rows[0],
      requested_at: result.rows[0].requested_at.toLocaleString('en-IN')
    },
    uploadedBy: uploadedByName,
    patientNotified: true,
    urgentAlert: urgent_flag || result_status === 'critical'
  };
};