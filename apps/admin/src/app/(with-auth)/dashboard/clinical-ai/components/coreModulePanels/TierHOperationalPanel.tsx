"use client";

/**
 * Tier H operational-forecasting admin panel — 8 modules registered via
 * migration 139, all wrapping `tierHOperationalService`.
 *
 * Operational forecasts (lab/radiology TAT, ambulance demand, queue
 * optimization) are decision-support only — never auto-dispatch staff /
 * resources. Tariff + package-compliance modules require finance review
 * before any insurance-facing change.
 */

import {
  Ambulance,
  ClipboardCheck,
  DollarSign,
  MessageSquare,
  Smile,
  Timer,
  Users,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const MODULES: TierModule[] = [
  {
    key: "lab_tat_delay_prediction",
    label: "Lab TAT",
    icon: Timer,
    endpoint: "/clinical-ai/lab-tat-delay-predictions",
    description: "Predicts lab turnaround-time delays from the current pending queue. Auto-fetches if queue_snapshot omitted.",
    body: { queue_snapshot: null },
  },
  {
    key: "radiology_tat_delay_prediction",
    label: "Radiology TAT",
    icon: Timer,
    endpoint: "/clinical-ai/radiology-tat-delay-predictions",
    description: "Predicts radiology turnaround-time delays from the current pending queue.",
    body: {
      queue_snapshot: [
        { id: 1, modality: "MRI", body_part: "brain", hours_pending: 18 },
        { id: 2, modality: "CT", body_part: "abdomen", hours_pending: 6 },
      ],
    },
  },
  {
    key: "ambulance_demand_forecast",
    label: "Ambulance demand",
    icon: Ambulance,
    endpoint: "/clinical-ai/ambulance-demand-forecasts",
    description: "Forecasts ambulance dispatch demand over the horizon hours window.",
    body: {
      horizon_hours: 12,
      recent_dispatches: [
        { id: 1, dispatched_at: "2026-04-30T08:00:00Z", dispatch_kind: "emergency" },
        { id: 2, dispatched_at: "2026-04-30T11:30:00Z", dispatch_kind: "transfer" },
      ],
    },
  },
  {
    key: "smart_queue_optimization",
    label: "Queue optimize",
    icon: Users,
    endpoint: "/clinical-ai/smart-queue-optimizations",
    description: "Generic queue optimizer (OPD / radiology / pharmacy / labs) — beyond ED-only boarding.",
    body: {
      queue_label: "opd",
      queue_snapshot: [
        { id: 1, position: 1, urgency: "normal" },
        { id: 2, position: 2, urgency: "high" },
      ],
      service_rate: null,
    },
  },
  {
    key: "tariff_optimization_insights",
    label: "Tariff insights",
    icon: DollarSign,
    endpoint: "/clinical-ai/tariff-optimization-insights",
    description: "Surfaces tariff anomalies + optimization candidates. Requires finance review before any insurance change.",
    body: { payer_id: null },
  },
  {
    key: "package_compliance_check",
    label: "Package check",
    icon: ClipboardCheck,
    endpoint: "/clinical-ai/package-compliance-checks",
    description: "Compliance check on an admission against its package (e.g. PKG-CABG-A).",
    body: { admission_id: 1, package_code: null },
  },
  {
    key: "patient_feedback_summary",
    label: "Feedback summary",
    icon: MessageSquare,
    endpoint: "/clinical-ai/patient-feedback-summaries",
    description: "Narrative summary over the recent patient feedback / NPS window.",
    body: { period_days: 30 },
  },
  {
    key: "sentiment_analysis",
    label: "Sentiment",
    icon: Smile,
    endpoint: "/clinical-ai/sentiment-analyses",
    description: "Free-text sentiment / theme classifier for a feedback string. Supports complaint routing.",
    body: { text: "The wait time was unacceptable and the receptionist was rude." },
  },
];

export function TierHOperationalPanel() {
  return (
    <TierGenericPanel
      title="Tier H — Operational forecasting"
      description="Decision-support only — never auto-dispatches staff / resources. Tariff + package-compliance modules require finance review before any insurance-facing change."
      modules={MODULES}
    />
  );
}

export default TierHOperationalPanel;
