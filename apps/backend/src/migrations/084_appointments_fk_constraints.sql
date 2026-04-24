-- 084_appointments_fk_constraints.sql
--
-- Declares appointment FKs so Prisma introspection produces include-
-- capable relations — same pattern as batch 082 (investigations) and
-- batch 083 (pharmacy).
--
-- Pre-flight on dev (appointments, 2026-04-24):
--   * 0 orphan patient_id rows (all non-null values exist in users.id)
--   * 0 orphan doctor_id rows (all non-null values exist in doctors.id)
--
-- Semantic note: appointments.doctor_id is treated as users.id by the
-- write path (appointmentService.createAppointment) and by most reads —
-- the column stores the doctor's users.id directly. One of the raw SELECT
-- variants in appointmentQueryService.js joined it to `doctors.id`
-- instead; that pattern happens to match in the dev dataset (doctors.id
-- and users.id collide for small N) but is semantically wrong.
-- Declaring the FK as users.id matches how the write path actually uses
-- the column. The `doctors` profile (specialty, department) still comes
-- through a second include via users.doctors (doctors.user_id).

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_patient_id_fkey,
  ADD CONSTRAINT appointments_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_doctor_id_fkey,
  ADD CONSTRAINT appointments_doctor_id_fkey
    FOREIGN KEY (doctor_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
