// Barrel for Phase-2 clinical-AI panels. Each new panel lands here as the
// `default` export re-exported under its PascalCase module name. Keeps
// clinical-ai/page.tsx's import list a single line regardless of how many
// modules are wired in.
//
// Convention: panel component name = PascalCase(module_key) + "Panel".
// See ./README.md for the full contract.

export { default as CybersecurityAnomalyPanel } from "./CybersecurityAnomalyPanel";
export { default as PharmacogenomicsPanel } from "./PharmacogenomicsPanel";

// Phase-2 simple list + decide panels (tracker rows 10–22).
export { default as AcuityStaffingForecastPanel } from "./AcuityStaffingForecastPanel";
export { default as EdTriagePredictorPanel } from "./EdTriagePredictorPanel";
export { default as PathwayBundleCompliancePanel } from "./PathwayBundleCompliancePanel";
export { default as IcuVentilatorBundlePanel } from "./IcuVentilatorBundlePanel";
export { default as RadiologyReportQaPanel } from "./RadiologyReportQaPanel";
export { default as RadiologyWorklistPrioritizerPanel } from "./RadiologyWorklistPrioritizerPanel";
export { default as ObstetricRiskPanel } from "./ObstetricRiskPanel";
export { default as HospitalCommandCenterPanel } from "./HospitalCommandCenterPanel";
export { default as HousekeepingBedTurnoverPanel } from "./HousekeepingBedTurnoverPanel";

export { default as AiAgentLifecyclePanel } from "./AiAgentLifecyclePanel";
export { default as ClinicalKnowledgeGraphPanel } from "./ClinicalKnowledgeGraphPanel";
export { default as FederatedLearningCoordinatorPanel } from "./FederatedLearningCoordinatorPanel";

// Phase-2 simple list + decide panels (tracker rows 23, 24, 28, 29, 30, 33, 37, 38, 39).
export { default as AiExplainabilityDashboardPanel } from "./AiExplainabilityDashboardPanel";
export { default as InventoryIntelligencePanel } from "./InventoryIntelligencePanel";
export { default as MultimodalPatientTimelinePanel } from "./MultimodalPatientTimelinePanel";
export { default as OtBlockSchedulingPanel } from "./OtBlockSchedulingPanel";
export { default as PolicyRegulationWatcherPanel } from "./PolicyRegulationWatcherPanel";
export { default as ProcurementNegotiationPanel } from "./ProcurementNegotiationPanel";
export { default as SyntheticCaseGeneratorPanel } from "./SyntheticCaseGeneratorPanel";
export { default as TrainingSimulationCoachPanel } from "./TrainingSimulationCoachPanel";
export { default as VoicePatientAssistantIvrPanel } from "./VoicePatientAssistantIvrPanel";

// Phase-2 two-tier panels (tracker rows 17, 25, 31, 32).
export { default as BiomedDeviceMaintenancePanel } from "./BiomedDeviceMaintenancePanel";
export { default as BloodBankForecastPanel } from "./BloodBankForecastPanel";
export { default as DatasetLabelingStudioPanel } from "./DatasetLabelingStudioPanel";
export { default as ModelRegistryWorkbenchPanel } from "./ModelRegistryWorkbenchPanel";
