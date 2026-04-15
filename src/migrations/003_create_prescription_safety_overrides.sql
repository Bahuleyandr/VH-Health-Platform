-- Audit log for clinicians overriding CDS blockers when prescribing.
-- Populated by ePrescriptionController.createPrescription when a caller supplies
-- { override: { reason, approvedBy? } } alongside a prescription that
-- validatePrescriptionSafety() flagged with blockers[].

CREATE TABLE IF NOT EXISTS prescription_safety_overrides (
  id            SERIAL PRIMARY KEY,
  prescription_id INTEGER REFERENCES e_prescriptions(id) ON DELETE CASCADE,
  patient_id    INTEGER NOT NULL,
  doctor_id     INTEGER NOT NULL,
  blockers      JSONB NOT NULL,
  reason        TEXT NOT NULL,
  approved_by   INTEGER,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rx_overrides_patient ON prescription_safety_overrides(patient_id);
CREATE INDEX IF NOT EXISTS idx_rx_overrides_created_at ON prescription_safety_overrides(created_at DESC);
