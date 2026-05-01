"use client";

/**
 * Tier E patient-engagement admin panel — 13 modules registered via
 * migration 136, all wrapping `tierEPatientEngagementService`.
 *
 * Drafts live in `clinical_ai_reviews` keyed by module_key — only after
 * clinician sign-off do they reach the patient via existing notification
 * channels. The patient app never displays a Tier E draft directly.
 */

import {
  Activity,
  Apple,
  Brain,
  Calendar,
  Dumbbell,
  HeartHandshake,
  Home,
  ListTodo,
  Pill,
  ShieldAlert,
  Stethoscope,
  Users,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const PATIENT = "11111111-1111-4111-8111-111111111111";

const MODULES: TierModule[] = [
  {
    key: "symptom_red_flag_checker",
    label: "Symptom red-flags",
    icon: ShieldAlert,
    endpoint: "/clinical-ai/symptom-red-flag-checks",
    description: "Live red-flag check on a patient-described symptom; routes to triage / nurse / 108 as appropriate.",
    body: {
      symptom_description: "I've had a severe headache and stiff neck for 4 hours, with vomiting twice.",
      age_years: 28,
      sex: "F",
      known_conditions: [],
      language: "en",
      patient_uid: PATIENT,
    },
  },
  {
    key: "chronic_disease_coach",
    label: "Chronic coach",
    icon: HeartHandshake,
    endpoint: "/clinical-ai/chronic-disease-coaching",
    description: "Coaching message tailored to the patient's chronic-disease registry entry.",
    body: { patient_uid: PATIENT, condition: "diabetes", language: "en" },
  },
  {
    key: "post_discharge_checkin_bot",
    label: "Post-discharge",
    icon: Calendar,
    endpoint: "/clinical-ai/post-discharge-checkins",
    description: "Day-N post-discharge check-in: red-flag screen + adherence + follow-up reminders.",
    body: { admission_id: 1, day_post_discharge: 3, language: "en" },
  },
  {
    key: "post_surgery_monitoring_bot",
    label: "Post-surgery",
    icon: Activity,
    endpoint: "/clinical-ai/post-surgery-monitoring",
    description: "Post-op-day-N monitoring questionnaire for a specific procedure.",
    body: { admission_id: 1, post_op_day: 5, procedure_name: "open cholecystectomy", language: "en" },
  },
  {
    key: "home_vitals_insights",
    label: "Home vitals",
    icon: Home,
    endpoint: "/clinical-ai/home-vitals-insights",
    description: "Insights on patient-recorded home vitals series.",
    body: {
      patient_uid: PATIENT,
      vitals_series: [
        { ts: "2026-04-29T08:00:00Z", sbp: 142, dbp: 92, hr: 84 },
        { ts: "2026-04-30T08:00:00Z", sbp: 138, dbp: 88, hr: 78 },
        { ts: "2026-05-01T08:00:00Z", sbp: 156, dbp: 96, hr: 82 },
      ],
      language: "en",
    },
  },
  {
    key: "diet_advice_draft",
    label: "Diet advice",
    icon: Apple,
    endpoint: "/clinical-ai/diet-advice-drafts",
    description: "Per-condition diet advice draft (clinician sign-off before sending).",
    body: { patient_uid: PATIENT, condition: "type-2 diabetes", restrictions: ["lactose-intolerant"], language: "en" },
  },
  {
    key: "exercise_advice_draft",
    label: "Exercise advice",
    icon: Dumbbell,
    endpoint: "/clinical-ai/exercise-advice-drafts",
    description: "Per-condition exercise advice draft.",
    body: { patient_uid: PATIENT, condition: "stable angina", restrictions: ["knee-OA"], language: "en" },
  },
  {
    key: "mental_health_screening_bot",
    label: "Mental health",
    icon: Brain,
    endpoint: "/clinical-ai/mental-health-screenings",
    description: "Standard MH screen (PHQ-9 / GAD-7) interpretation + safety triage.",
    body: {
      patient_uid: PATIENT,
      screen: "phq9",
      responses: [2, 2, 1, 3, 1, 2, 0, 0, 0],
      language: "en",
    },
  },
  {
    key: "medication_reminder_generator",
    label: "Med reminder",
    icon: Pill,
    endpoint: "/clinical-ai/medication-reminders",
    description: "Drafts a friendly medication-reminder sequence for the patient's active prescriptions.",
    body: { patient_uid: PATIENT, language: "en" },
  },
  {
    key: "follow_up_reminder_generator",
    label: "Follow-up",
    icon: Calendar,
    endpoint: "/clinical-ai/follow-up-reminders",
    description: "Drafts reminders for upcoming follow-up appointments / pending lab reviews.",
    body: { admission_id: 1, language: "en" },
  },
  {
    key: "pre_visit_form_assistant",
    label: "Pre-visit form",
    icon: ListTodo,
    endpoint: "/clinical-ai/pre-visit-forms",
    description: "Pre-visit questionnaire tailored to the appointment reason + specialty.",
    body: {
      patient_uid: PATIENT,
      appointment_reason: "follow-up for thyroid",
      department_specialty: "Endocrinology",
      language: "en",
    },
  },
  {
    key: "preventive_health_recommender",
    label: "Preventive",
    icon: Stethoscope,
    endpoint: "/clinical-ai/preventive-health-recommendations",
    description: "Age/sex/comorbidity-aware preventive screening recommendations.",
    body: {
      patient_uid: PATIENT,
      age_years: 52,
      sex: "F",
      comorbidities: ["hypertension"],
      family_history: ["breast_cancer", "diabetes"],
      language: "en",
    },
  },
  {
    key: "family_health_risk_summary",
    label: "Family risk",
    icon: Users,
    endpoint: "/clinical-ai/family-health-risk-summaries",
    description: "Family-history-driven risk summary for the patient.",
    body: {
      patient_uid: PATIENT,
      family_history_entries: [
        { relative: "father", condition: "myocardial_infarction", age_at_diagnosis: 52 },
        { relative: "mother", condition: "diabetes_t2", age_at_diagnosis: 48 },
      ],
      language: "en",
    },
  },
];

export function TierEPatientEngagementPanel() {
  return (
    <TierGenericPanel
      title="Tier E — Patient engagement"
      description="Drafts always require clinician sign-off; only after sign-off does the patient see the message via existing notification channels. The patient app never renders a Tier E draft directly."
      modules={MODULES}
    />
  );
}

export default TierEPatientEngagementPanel;
