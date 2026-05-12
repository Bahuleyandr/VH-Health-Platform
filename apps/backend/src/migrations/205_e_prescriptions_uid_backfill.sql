-- Backfill patient_uid / doctor_uid on e_prescriptions rows created
-- before commit 04dadb6f added the write-side resolution. Every
-- prescription where the uuid columns are NULL but the int id exists
-- on `users` gets stitched up so the patient app's uid-based Rx-list
-- filter and pharmacy lookups can see them.
--
-- Finding: 2026-05-08-walk-in-opd-doctor-prescription-uid-fields-null.

UPDATE e_prescriptions p
   SET patient_uid = u.uid
  FROM users u
 WHERE p.patient_uid IS NULL
   AND p.patient_id IS NOT NULL
   AND u.id = p.patient_id;

UPDATE e_prescriptions p
   SET doctor_uid = u.uid
  FROM users u
 WHERE p.doctor_uid IS NULL
   AND p.doctor_id IS NOT NULL
   AND u.id = p.doctor_id;
