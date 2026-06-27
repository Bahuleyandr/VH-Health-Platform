// src/config/uploadConfig.js - Hospital Upload Configuration

export const HOSPITAL_UPLOAD_CONFIG = {
  allowedMimeTypes: [
    // Images - Medical imaging and documents
    // NOTE: image/svg+xml is intentionally excluded. SVGs can embed <script>
    // and are served inline from R2 signed URLs => stored XSS. Medical images
    // are raster (JPEG/PNG/TIFF/etc.) or PDF; there is no clinical need for SVG.
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
    'image/bmp',
    // Documents - Medical records and reports
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // NOTE: text/plain, text/csv, text/rtf are intentionally excluded (M-5).
    // text/* skips magic-byte verification (validateMagicBytes relaxed clause)
    // and is served inline from R2 signed URLs => an attacker-uploaded HTML
    // payload labelled text/plain renders as a page (stored XSS). The clinical-AI
    // document-intake routes (documentRoutes.js / knowledgeBaseRoutes.js) keep
    // text/* for OCR via their OWN admin-only MIME allowlists — they do not use
    // this global list, so removing it here does not affect them.
    // Medical specific formats
    'application/dicom', // DICOM medical imaging
    'application/hl7-v2+er7', // HL7 medical data exchange
    'application/fhir+json', // FHIR healthcare data
    // Audio/Video for telemedicine
    'audio/mpeg', 'audio/wav', 'audio/mp4',
    'video/mp4', 'video/avi', 'video/quicktime'
  ],
  maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB for medical files
  imageMaxWidth: 4096, // High resolution for medical imaging
  imageMaxHeight: 4096,
  imageQuality: 95, // High quality for medical images

  // Operational photo settings (housekeeping, incidents, grievances)
  // Much smaller — 800px max, 70% quality, ~50-100KB vs 1-5MB for medical
  operationalImageMaxWidth: 1280,
  operationalImageMaxHeight: 1280,
  operationalImageQuality: 72,
  operationalCategories: ['housekeeping_log', 'housekeeping_request', 'incident_photo', 'grievance_evidence'],
  allowedCategories: [
    'medical_record', 'prescription', 'lab_report', 'xray', 'mri', 'ct_scan',
    'ultrasound', 'ecg', 'eeg', 'pathology_report', 'discharge_summary',
    'consent_form', 'insurance_document', 'id_document', 'profile_picture',
    'surgery_notes', 'progress_notes', 'referral_letter', 'vaccination_record',
    'allergy_record', 'medication_list', 'treatment_plan', 'consultation_notes',
    'telemedicine_recording', 'rehabilitation_plan', 'mental_health_assessment',
    // Operational / non-clinical
    'housekeeping_log', 'housekeeping_request', 'incident_photo', 'grievance_evidence'
  ],
  hipaaCategories: [
    'medical_record', 'lab_report', 'pathology_report', 'surgery_notes',
    'progress_notes', 'mental_health_assessment', 'treatment_plan'
  ],
  retentionPeriods: {
    'medical_record': 7 * 365, // 7 years
    'lab_report': 7 * 365,
    'xray': 5 * 365, // 5 years
    'prescription': 2 * 365, // 2 years
    'profile_picture': 1 * 365, // 1 year
    'consultation_notes': 7 * 365,
    'default': 3 * 365, // 3 years default
    // Operational photos — short retention
    'housekeeping_log':     90,   // 90 days — cleaning evidence
    'housekeeping_request': 90,   // 90 days — request photos
    'incident_photo':       365,  // 1 year — incident evidence (compliance)
    'grievance_evidence':   365   // 1 year — grievance evidence
  }
};

export const MULTER_CONFIG = {
  limits: { 
    fileSize: HOSPITAL_UPLOAD_CONFIG.maxFileSizeBytes,
    files: 10, // Max 10 files per request
    fieldNameSize: 200,
    fieldSize: 1024
  }
};