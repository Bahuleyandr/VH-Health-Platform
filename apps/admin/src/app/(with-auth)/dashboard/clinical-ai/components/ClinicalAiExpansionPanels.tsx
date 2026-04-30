"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentType } from "react";

type PanelComponent = ComponentType<Record<string, never>>;

function panelLoading() {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="h-5 w-56 animate-pulse rounded bg-muted" />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="h-24 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded bg-muted" />
      </div>
    </section>
  );
}

function deferredPanel(importer: () => Promise<{ default: PanelComponent }>) {
  return dynamic(importer, { ssr: false, loading: panelLoading });
}

function ViewportPanel({ component: Component }: { component: PanelComponent }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (shouldRender) return;
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      { rootMargin: "900px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldRender]);

  return <div ref={ref}>{shouldRender ? <Component /> : panelLoading()}</div>;
}

const PANELS: PanelComponent[] = [
  deferredPanel(() => import("./coreModulePanels/PromptExperimentsPanel")),
  deferredPanel(() => import("./coreModulePanels/DriftCanaryPanel")),
  deferredPanel(() => import("./coreModulePanels/RegulatoryReadinessPackPanel")),
  deferredPanel(() => import("./coreModulePanels/KnowledgeBasePanel")),
  deferredPanel(() => import("./coreModulePanels/DeteriorationPanel")),
  deferredPanel(() => import("./coreModulePanels/ImagingAIPanel")),
  deferredPanel(() => import("./coreModulePanels/VirtualWardPanel")),
  deferredPanel(() => import("./coreModulePanels/DocumentIntelligencePanel")),
  deferredPanel(() => import("./coreModulePanels/AdmissionAiDraftWorkbenchPanel")),
  deferredPanel(() => import("./coreModulePanels/ChartCompletionPanel")),
  deferredPanel(() => import("./coreModulePanels/ClinicalTaskExtractorPanel")),
  deferredPanel(() => import("./coreModulePanels/AbnormalResultTriagePanel")),
  deferredPanel(() => import("./coreModulePanels/InfectionControlSentinelPanel")),
  deferredPanel(() => import("./coreModulePanels/AntimicrobialStewardshipPanel")),
  deferredPanel(() => import("./coreModulePanels/PatientTeachBackPanel")),
  deferredPanel(() => import("./coreModulePanels/AppealLetterGeneratorPanel")),
  deferredPanel(() => import("./coreModulePanels/PayerContractVariancePanel")),
  deferredPanel(() => import("./coreModulePanels/LabAutoverificationPanel")),
  deferredPanel(() => import("./coreModulePanels/PediatricDosingSafetyPanel")),
  deferredPanel(() => import("./coreModulePanels/AiRoiDashboardPanel")),
  deferredPanel(() => import("./coreModulePanels/SepsisBundleSentinelPanel")),
  deferredPanel(() => import("./coreModulePanels/PrivacySentinelPanel")),
  deferredPanel(() => import("./coreModulePanels/AmbientDocumentationPanel")),
  deferredPanel(() => import("./coreModulePanels/NursingAmbientDocumentationPanel")),
  deferredPanel(() => import("./coreModulePanels/FamilyUpdateGeneratorPanel")),
  deferredPanel(() => import("./coreModulePanels/RosterOptimizerPanel")),
  deferredPanel(() => import("./coreModulePanels/StaffBurnoutRiskPanel")),
  deferredPanel(() => import("./coreModulePanels/PolypharmacyPanel")),
  deferredPanel(() => import("./coreModulePanels/TrialCatalogSyncPanel")),
  deferredPanel(() => import("./coreModulePanels/TrialMatchesPanel")),
  deferredPanel(() => import("./coreModulePanels/RcaDraftsPanel")),
  deferredPanel(() => import("./coreModulePanels/ForecastWorkbenchPanel")),
  deferredPanel(() => import("./coreModulePanels/OperationalPredictionPanel")),
  deferredPanel(() => import("./coreModulePanels/ChargeCapturePanel")),
  deferredPanel(() => import("./coreModulePanels/PriorAuthorizationPanel")),
  deferredPanel(() => import("./deferredModulePanels/AcuityStaffingForecastPanel")),
  deferredPanel(() => import("./deferredModulePanels/EdTriagePredictorPanel")),
  deferredPanel(() => import("./deferredModulePanels/PathwayBundleCompliancePanel")),
  deferredPanel(() => import("./deferredModulePanels/IcuVentilatorBundlePanel")),
  deferredPanel(() => import("./deferredModulePanels/RadiologyReportQaPanel")),
  deferredPanel(() => import("./deferredModulePanels/RadiologyWorklistPrioritizerPanel")),
  deferredPanel(() => import("./deferredModulePanels/BloodBankForecastPanel")),
  deferredPanel(() => import("./deferredModulePanels/PharmacogenomicsPanel")),
  deferredPanel(() => import("./deferredModulePanels/ObstetricRiskPanel")),
  deferredPanel(() => import("./deferredModulePanels/HospitalCommandCenterPanel")),
  deferredPanel(() => import("./deferredModulePanels/HousekeepingBedTurnoverPanel")),
  deferredPanel(() => import("./deferredModulePanels/OtBlockSchedulingPanel")),
  deferredPanel(() => import("./deferredModulePanels/InventoryIntelligencePanel")),
  deferredPanel(() => import("./deferredModulePanels/BiomedDeviceMaintenancePanel")),
  deferredPanel(() => import("./deferredModulePanels/CybersecurityAnomalyPanel")),
  deferredPanel(() => import("./deferredModulePanels/TrainingSimulationCoachPanel")),
  deferredPanel(() => import("./deferredModulePanels/PolicyRegulationWatcherPanel")),
  deferredPanel(() => import("./deferredModulePanels/ProcurementNegotiationPanel")),
  deferredPanel(() => import("./deferredModulePanels/ModelRegistryWorkbenchPanel")),
  deferredPanel(() => import("./deferredModulePanels/DatasetLabelingStudioPanel")),
  deferredPanel(() => import("./deferredModulePanels/SyntheticCaseGeneratorPanel")),
  deferredPanel(() => import("./deferredModulePanels/FederatedLearningCoordinatorPanel")),
  deferredPanel(() => import("./deferredModulePanels/AiAgentLifecyclePanel")),
  deferredPanel(() => import("./deferredModulePanels/ClinicalKnowledgeGraphPanel")),
  deferredPanel(() => import("./deferredModulePanels/MultimodalPatientTimelinePanel")),
  deferredPanel(() => import("./deferredModulePanels/VoicePatientAssistantIvrPanel")),
  deferredPanel(() => import("./deferredModulePanels/AiExplainabilityDashboardPanel")),
];

export function ClinicalAiExpansionPanels() {
  return (
    <>
      {PANELS.map((Panel, index) => (
        <ViewportPanel key={index} component={Panel} />
      ))}
    </>
  );
}
