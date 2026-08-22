-- 725_care_pathway_actionable_roles_role_sync.sql
--
-- Re-sync care_pathway_route_actionable_roles with the servicing route
-- policies after the 2026-08-22 role-list corrections (PR #908: ANAESTHETIST
-- became a first-class member of roleHelpers.CLINICAL_ROLES, which feeds the
-- role-policy graph and reordered the derived CLINICAL_STAFF_ROUTE_ROLES).
-- src/tests/care-pathway-schema-conformance.deep.test.js pins the DB arrays
-- ORDER-EXACTLY to the code lists, so any role-registry change must land with
-- a migration like this one. Arrays below are generated from the code lists,
-- not hand-transcribed.

CREATE OR REPLACE FUNCTION care_pathway_route_actionable_roles(
  obligation_rule_code TEXT
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN obligation_rule_code = 'cold_chain_excursion_ack' THEN ARRAY[
      'SUPER_ADMIN', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'ADMIN',
      'PHARMACIST', 'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST',
      'RADIOLOGIST', 'RADIOLOGY_STAFF', 'BLOOD_BANK_TECHNICIAN',
      'BLOOD_BANK_STAFF', 'DOCTOR', 'NURSING_STAFF', 'OP_STAFF_NURSE',
      'IP_STAFF_NURSE', 'CATH_LAB_STAFF', 'DUTY_DOCTOR', 'NURSING_INCHARGE',
      'IP_INCHARGE', 'OT_NURSE', 'OT_INCHARGE', 'CATH_LAB_INCHARGE',
      'ANESTHETIST', 'ANAESTHETIST', 'ADMISSION_OFFICER', 'IPD_COUNSELLOR',
      'OT_STAFF', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'SENIOR_DOCTOR',
      'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'DIALYSIS_TECHNICIAN',
      'MEDICAL_SUPERINTENDENT', 'CMO', 'CNO'
    ]::TEXT[]
    ELSE ARRAY[
      'SUPER_ADMIN', 'DOCTOR', 'DUTY_DOCTOR', 'MEDICAL_SUPERINTENDENT',
      'NURSING_STAFF', 'NURSING_INCHARGE', 'OP_STAFF_NURSE', 'OP_INCHARGE',
      'IP_STAFF_NURSE', 'IP_INCHARGE', 'OT_NURSE', 'OT_INCHARGE',
      'CATH_LAB_STAFF', 'CATH_LAB_INCHARGE', 'PHARMACY_STAFF',
      'PHARMACY_INCHARGE', 'MEDICAL_RECORDS', 'ADMIN', 'ANESTHETIST',
      'ANAESTHETIST', 'ADMISSION_OFFICER', 'IPD_COUNSELLOR', 'OT_STAFF',
      'CMO', 'CNO', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT',
      'SENIOR_DOCTOR', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF',
      'PHARMACIST'
    ]::TEXT[]
  END;
$$;
