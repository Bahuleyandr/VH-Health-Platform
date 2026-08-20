"use client";

import type { IntegrationGateEnvFacts } from "@/lib/api/integrationGates";

function Fact({
  label,
  on,
  detail,
}: {
  label: string;
  on: boolean;
  detail?: string | null;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <span className="text-sm text-foreground">{label}</span>
      <span
        className={`text-xs font-semibold ${on ? "text-success" : "text-muted-foreground"}`}
      >
        {on ? "ON" : "off"}
        {detail ? ` · ${detail}` : ""}
      </span>
    </div>
  );
}

export function EnvFactsCard({ env }: { env: IntegrationGateEnvFacts }) {
  return (
    <div className="rounded-lg bg-card p-6 shadow">
      <h2 className="mb-1 text-lg font-medium text-foreground">
        Deployment environment switches
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Read-only facts from the backend environment. Changing these is a
        deployment (ArgoCD) operation, not a console action.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Fact
          label="Payment gateway (PAYMENT_GATEWAY_ENABLED)"
          on={env.payment_gateway_enabled}
        />
        <Fact
          label="SMS provider (SMS_PROVIDER)"
          on={!env.sms_kill_switch && Boolean(env.sms_provider)}
          detail={env.sms_provider ?? "unset"}
        />
        <Fact
          label="ABDM (ABDM_ENABLED)"
          on={env.abdm_enabled}
          detail={`${env.abdm_environment}${env.abdm_has_client_credentials ? ", creds present" : ", creds missing"}`}
        />
        <Fact
          label="UHI (UHI_ENABLED)"
          on={env.uhi_enabled}
          detail={env.uhi_environment}
        />
        <Fact label="LiveKit (LIVEKIT_ENABLED)" on={env.livekit_enabled} />
        <Fact
          label="File scanning (FILE_SCAN_POLICY)"
          on={env.file_scan_policy === "required"}
          detail={env.file_scan_policy}
        />
        <Fact
          label="Clinical continuity (compile-time C-D14)"
          on={env.clinical_continuity_c_d14_approved}
        />
        {/* Terminology & knowledge env facts (slate C1; appended block).
            Optional-guarded so the card renders against a backend that
            predates these facts. */}
        <Fact
          label="WHO ICD-11 API (WHO_ICD_* creds)"
          on={env.who_icd_configured === true}
        />
        <Fact
          label="Coding enforcement (TERMINOLOGY_CODING_ENFORCEMENT)"
          on={
            env.terminology_coding_enforcement === "warn" ||
            env.terminology_coding_enforcement === "block"
          }
          detail={env.terminology_coding_enforcement ?? "off"}
        />
        <Fact
          label="Drug KB deterministic matching (DRUG_KB_DETERMINISTIC_MATCHING)"
          on={env.drug_kb_deterministic_matching === true}
        />
        <Fact
          label="Lab LOINC mapping (LAB_LOINC_MAPPING_ENABLED)"
          on={env.lab_loinc_mapping_enabled === true}
        />
      </div>
    </div>
  );
}

export default EnvFactsCard;
