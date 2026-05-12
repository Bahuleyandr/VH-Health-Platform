-- One-time cleanup of stale occupant FKs on beds that are already marked
-- 'available'. The bed map UI trusted `status` alone and exposed
-- previously-occupied rows still pointing at past patients; the
-- legacy bedService.dischargePatient path nulled patient_id but left
-- patient_uid / admission_id behind, so a discharged patient's UID
-- could surface on the bed map even after a fresh admit elsewhere.
--
-- The discharge path is patched alongside this migration; this DML
-- closes the data gap for rows already in the broken state.
--
-- Finding: 2026-05-10-dynamic-acute-abdomen-admission-available-bed-retains-active-patient.

UPDATE beds
   SET patient_uid  = NULL,
       patient_id   = NULL,
       patient_name = NULL,
       admission_id = NULL,
       admitted_at  = NULL,
       expected_discharge = NULL,
       updated_at   = NOW()
 WHERE status = 'available'
   AND (patient_uid IS NOT NULL
        OR patient_id IS NOT NULL
        OR admission_id IS NOT NULL);
