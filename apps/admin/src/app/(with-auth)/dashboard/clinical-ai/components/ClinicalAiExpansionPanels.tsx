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

function corePanel(exportName: string) {
  return dynamic(
    () =>
      import("./AIExpansionPanels").then((module) => {
        const component = module[exportName as keyof typeof module] as PanelComponent | undefined;
        if (!component) {
          throw new Error(`Clinical AI panel export not found: ${exportName}`);
        }
        return component;
      }),
    { ssr: false, loading: panelLoading },
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
  corePanel("PromptExperimentsPanel"),
  corePanel("DriftCanaryPanel"),
  corePanel("DeteriorationPanel"),
  corePanel("ImagingAIPanel"),
  corePanel("VirtualWardPanel"),
  corePanel("DocumentIntelligencePanel"),
  corePanel("AdmissionAiDraftWorkbenchPanel"),
  corePanel("ChartCompletionPanel"),
  corePanel("ClinicalTaskExtractorPanel"),
  corePanel("AbnormalResultTriagePanel"),
  corePanel("InfectionControlSentinelPanel"),
  corePanel("AntimicrobialStewardshipPanel"),
  corePanel("PatientTeachBackPanel"),
  corePanel("AppealLetterGeneratorPanel"),
  corePanel("PayerContractVariancePanel"),
  corePanel("LabAutoverificationPanel"),
  corePanel("PediatricDosingSafetyPanel"),
  corePanel("AiRoiDashboardPanel"),
  corePanel("SepsisBundleSentinelPanel"),
  corePanel("PrivacySentinelPanel"),
  corePanel("AmbientDocumentationPanel"),
  corePanel("NursingAmbientDocumentationPanel"),
  corePanel("FamilyUpdateGeneratorPanel"),
  corePanel("RosterOptimizerPanel"),
  corePanel("StaffBurnoutRiskPanel"),
  corePanel("PolypharmacyPanel"),
  corePanel("TrialCatalogSyncPanel"),
  corePanel("TrialMatchesPanel"),
  corePanel("RcaDraftsPanel"),
  corePanel("ForecastWorkbenchPanel"),
  corePanel("OperationalPredictionPanel"),
  corePanel("ChargeCapturePanel"),
  corePanel("PriorAuthorizationPanel"),
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
