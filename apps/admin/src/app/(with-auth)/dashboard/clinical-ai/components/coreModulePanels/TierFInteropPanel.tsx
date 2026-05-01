"use client";

/**
 * Tier F interoperability admin panel — 5 modules registered via
 * migration 137, all wrapping `tierFInteropService`. Default review
 * roles include INTEGRATION_ADMIN; sign-off required before any
 * external-facing payload is dispatched.
 */

import {
  ArrowLeftRight,
  CheckCircle2,
  FileSpreadsheet,
  Files,
  Link2,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const MODULES: TierModule[] = [
  {
    key: "fhir_validation_assistant",
    label: "FHIR validation",
    icon: CheckCircle2,
    endpoint: "/clinical-ai/fhir-validations",
    description: "Validates a FHIR R4 resource against profile + invariant rules.",
    body: {
      resource_type: "Patient",
      resource_json: {
        resourceType: "Patient",
        id: "p1",
        name: [{ family: "Doe", given: ["Jane"] }],
        gender: "female",
        birthDate: "1985-04-12",
      },
    },
  },
  {
    key: "abdm_care_context_assistant",
    label: "ABDM care ctx",
    icon: Link2,
    endpoint: "/clinical-ai/abdm-care-contexts",
    description: "Drafts the ABDM care-context payload for an admission ready for HIE-CM linking.",
    body: { admission_id: 1 },
  },
  {
    key: "health_record_reconciliation",
    label: "Record reconcile",
    icon: ArrowLeftRight,
    endpoint: "/clinical-ai/health-record-reconciliations",
    description: "Surfaces conflicts between two patient-record sources before merge.",
    body: {
      record_a: { name: "Mahalakshmi", dob: "1985-04-12", sex: "F" },
      record_b: { name: "Mahalakshmi S", dob: "1985-04-12", sex: "F" },
      patient_uid: null,
    },
  },
  {
    key: "document_patient_matching",
    label: "Doc-patient match",
    icon: Files,
    endpoint: "/clinical-ai/document-patient-matching",
    description: "Suggests the right patient UID for an unattached document, with confidence.",
    body: {
      document_text: "Discharge summary for patient with community-acquired pneumonia, 5-day course of amoxicillin, follow-up in 1 week.",
      candidate_patients: [
        { uid: "11111111-1111-4111-8111-111111111111", name: "Test Patient", phone: "+919876543210" },
      ],
    },
  },
  {
    key: "medical_record_bundle_generator",
    label: "Record bundle",
    icon: FileSpreadsheet,
    endpoint: "/clinical-ai/medical-record-bundles",
    description: "Assembles an insurance / referral / ABDM bundle for an admission.",
    body: { admission_id: 1, scope: "insurance" },
  },
];

export function TierFInteropPanel() {
  return (
    <TierGenericPanel
      title="Tier F — Interoperability"
      description="Default review role is INTEGRATION_ADMIN. Drafts must be signed off before any external-facing payload (FHIR bundle / ABDM care-context / insurance pack) is dispatched."
      modules={MODULES}
    />
  );
}

export default TierFInteropPanel;
