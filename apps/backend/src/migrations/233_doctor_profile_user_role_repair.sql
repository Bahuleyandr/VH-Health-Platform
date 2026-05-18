-- 233_doctor_profile_user_role_repair.sql
--
-- Doctor roster repair.
--
-- The doctor master can only be clinically assignable if doctors.user_id
-- points at an active users row with role=DOCTOR. A local seed script used to
-- create doctor users without setting role/name, leaving visible consultants
-- (for example Ophthalmology) linked to PATIENT rows and causing
-- POST /appointments/walk-in to reject the selected consultant.

BEGIN;

UPDATE users u
       SET role = 'DOCTOR',
           name = COALESCE(NULLIF(u.name, ''), d.name),
           is_active = true,
           status = 'active',
           updated_at = NOW()
  FROM doctors d
 WHERE d.user_id = u.id
   AND d.is_active = true
   AND (
     u.role IS DISTINCT FROM 'DOCTOR'
     OR u.is_active IS DISTINCT FROM true
     OR u.status IS DISTINCT FROM 'active'
     OR u.name IS NULL
     OR u.name = ''
   );

COMMIT;
