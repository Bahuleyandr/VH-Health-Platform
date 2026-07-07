-- N6-4: anatomic pathology investigation catalog seeds.

INSERT INTO investigation_test_catalog
  (name, code, category, description, default_cost, turnaround_hours, requires_fasting, sample_type, patient_instructions, is_active)
VALUES
  (
    'Histopathology biopsy',
    'HISTO-BIOPSY',
    'Anatomic Pathology',
    'Biopsy specimen accessioning, grossing, block/slide processing, and diagnostic histopathology report.',
    2500.00,
    72,
    FALSE,
    'tissue',
    'Submit tissue in correctly labelled formalin container with clinical history.',
    TRUE
  ),
  (
    'Frozen section',
    'FROZEN',
    'Anatomic Pathology',
    'Intra-operative frozen section consultation with rapid pathologist report.',
    3500.00,
    1,
    FALSE,
    'fresh tissue',
    'Send fresh tissue immediately with surgeon contact details and clinical question.',
    TRUE
  ),
  (
    'Fine needle aspiration cytology',
    'FNAC',
    'Anatomic Pathology',
    'FNAC cytology accessioning, slide review, and cytopathology report.',
    1200.00,
    24,
    FALSE,
    'cytology smear',
    'Submit air-dried and alcohol-fixed smears with lesion site and clinical history.',
    TRUE
  ),
  (
    'Pap smear cytology',
    'PAP',
    'Anatomic Pathology',
    'Cervical cytology screening and diagnostic cytopathology report.',
    900.00,
    48,
    FALSE,
    'cervical smear',
    'Avoid vaginal medication or douching before sample collection unless clinically directed.',
    TRUE
  ),
  (
    'Fluid cytology',
    'FLUID-CYTO',
    'Anatomic Pathology',
    'Body-fluid cytology processing and diagnostic cytopathology report.',
    1500.00,
    48,
    FALSE,
    'fluid',
    'Send fresh fluid promptly in a sterile labelled container.',
    TRUE
  )
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  default_cost = EXCLUDED.default_cost,
  turnaround_hours = EXCLUDED.turnaround_hours,
  requires_fasting = EXCLUDED.requires_fasting,
  sample_type = EXCLUDED.sample_type,
  patient_instructions = EXCLUDED.patient_instructions,
  is_active = TRUE,
  updated_at = NOW();
