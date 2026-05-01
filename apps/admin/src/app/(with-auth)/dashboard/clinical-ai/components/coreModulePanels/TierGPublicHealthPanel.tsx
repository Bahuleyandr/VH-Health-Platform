"use client";

/**
 * Tier G public / population-health admin panel — 5 modules registered
 * via migration 138, all wrapping `tierGPublicHealthService`.
 *
 * Public-health output is reviewed by ADMIN / DATA_PROTECTION_OFFICER
 * before dispatch to a registry / public-health authority.
 */

import {
  ClipboardList,
  EyeOff,
  FileText,
  Layers,
  Search,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const MODULES: TierModule[] = [
  {
    key: "chronic_disease_registry",
    label: "Chronic registry",
    icon: ClipboardList,
    endpoint: "/clinical-ai/chronic-disease-registries",
    description: "Aggregate registry overview for one chronic-disease cohort (diabetes, hypertension, etc.).",
    body: { condition: "diabetes" },
  },
  {
    key: "screening_gap_detection",
    label: "Screening gaps",
    icon: Search,
    endpoint: "/clinical-ai/screening-gap-detections",
    description: "Detects screening gaps for a recommended screening type (cervical / colorectal / etc.).",
    body: { screening_type: "cervical" },
  },
  {
    key: "high_risk_patient_cohorts",
    label: "High-risk cohorts",
    icon: Layers,
    endpoint: "/clinical-ai/high-risk-cohorts",
    description: "Builds an SQL-backed high-risk cohort definition (separate from trial matcher).",
    body: { criteria: { admissions_in_12mo: 3, comorbidity_count: 3 } },
  },
  {
    key: "public_health_report_generator",
    label: "PH report",
    icon: FileText,
    endpoint: "/clinical-ai/public-health-reports",
    description: "Drafts a public-health report (notifiable disease / outbreak / monthly aggregate).",
    body: { report_type: "notifiable_disease", period_days: 30 },
  },
  {
    key: "phi_deidentification",
    label: "PHI de-id",
    icon: EyeOff,
    endpoint: "/clinical-ai/phi-deidentifications",
    description: "Strips Safe-Harbor identifiers from arbitrary clinical text. Requires DPO sign-off before research dispatch.",
    body: {
      source_text: "Patient John Doe, phone 9876543210, presented on 2026-04-30 with cough x 3 days. MRN: 12345.",
      retain_safe_harbor: false,
    },
  },
];

export function TierGPublicHealthPanel() {
  return (
    <TierGenericPanel
      title="Tier G — Public / population health"
      description="Output is reviewed by ADMIN / DATA_PROTECTION_OFFICER before dispatch to any registry or public-health authority. PHI de-identification carries Safe-Harbor checks."
      modules={MODULES}
    />
  );
}

export default TierGPublicHealthPanel;
