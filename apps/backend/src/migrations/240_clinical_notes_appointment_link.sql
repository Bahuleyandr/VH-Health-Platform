-- 234_clinical_notes_appointment_link.sql
--
-- Walk-in OPD clinical notes had no way to bind to the appointment they
-- documented: clinical_notes.encounter_id is a UUID that only resolves to
-- admissions.encounter_id or emergency_visits.encounter_id. OPD
-- appointments have no encounter row, so notes for an OPD visit floated
-- free of the visit they documented and could not be grouped under the
-- patient's "consultations" tab.
--
-- Finding: 2026-05-17-dynamic-acute-abdomen-doctor-89b02076
--   POST /api/v1/emr/notes accepts no appointment_id — clinical note has
--   no linkage to the visit it documents.
--
-- Additive / nullable / no default — safe on a live DB.

ALTER TABLE public.clinical_notes
    ADD COLUMN IF NOT EXISTS appointment_id integer;

ALTER TABLE public.clinical_notes
    DROP CONSTRAINT IF EXISTS clinical_notes_appointment_id_fk;

ALTER TABLE public.clinical_notes
    ADD CONSTRAINT clinical_notes_appointment_id_fk
    FOREIGN KEY (appointment_id) REFERENCES public.appointments (id)
    ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_appointment
    ON public.clinical_notes (appointment_id, created_at DESC)
    WHERE appointment_id IS NOT NULL;
