# India Deployment Readiness

Status date: 2026-06-11. Scope: compliance, validation, and go-live evidence
for an Indian hospital deployment of VH Health Platform. This runbook is an
operator checklist, not legal advice; hospital counsel and the appointed data
protection/security officers must approve the final packet before real patient
PHI is accepted.

Companion docs:

- [`ABDM_READINESS.md`](ABDM_READINESS.md) - ABDM/ABHA technical status and
  preflight.
- [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) - on-prem Kubernetes deployment.
- [`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md) -
  security owner actions.
- [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) - timed restore drill.
- [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md) - ward downtime packs.
- [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md) -
  Clinical AI rollout governance.

## Official references to re-check at go-live

Use current official copies before a production launch:

- MeitY: [Digital Personal Data Protection Act, 2023](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf).
- MeitY: [Digital Personal Data Protection Rules, 2025](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf).
- CERT-In: [Cyber Security Directions, 28.04.2022](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf).
- CERT-In: [FAQ on Cyber Security Directions](https://www.cert-in.org.in/PDF/FAQs_on_CyberSecurityDirections_May2022.pdf).
- ABDM/NHA: [HIP/HIU Guidelines](https://abdm.gov.in/strapicms/uploads/HIP_HIU_Guidelines_f85df336ec.pdf).
- ABDM/NHA: [Health Data Management Policy](https://abdm.gov.in/strapicms/uploads/health_management_policy_bac9429a79.pdf).
- ABDM sandbox: [M2 HIP API documentation](https://sandboxcms.abdm.gov.in/uploads/Updated_M2_Document_fccd996be2.pdf).
- ABDM/NHA: [ABHA privacy policy](https://abdm.gov.in/abha-PRIVACY-POLICY-english).
- MeitY: [Information Technology Rules, 2021, updated 10.02.2026](https://www.meity.gov.in/static/uploads/2026/02/550681ab908f8afb135b0ad42816a1c9.pdf).
- CDSCO: [Medical device and diagnostics portal](https://cdsco.gov.in/opencms/opencms/en/Medical-Device-Diagnostics/Medical-Device-Diagnostics/).
- CDSCO: [draft guidance on Medical Device Software, 2025](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadPublic_NoticesFiles/Draft%20guidance%20document%20on%20Medical%20Device%20Software%2021%2010%202025.pdf).
- MoHFW: [DISHA draft comments page](https://www.mohfw.gov.in/newshighlights/comments-draft-digital-information-security-health-care-actdisha).

## Go-live decision

Real patient PHI/PII is blocked until every **Must** gate below is green and
the **Counsel/official sign-off** items are either approved or explicitly
deferred in the hospital risk register.

| Area | Gate | Evidence required | Metric |
|---|---|---|---|
| Legal basis and data roles | Must | Signed hospital/platform responsibility matrix naming Data Fiduciary, processor/sub-processor, security POC, grievance owner, breach owner, and ABDM owner. | 100% roles assigned with backup contacts. |
| DPDP notice and consent | Must | Privacy notice, consent text, retention schedule, data-sharing list, consent withdrawal flow, and data-principal request SOP approved by counsel. | 100% processing purposes mapped to notice/consent or another counsel-approved ground. |
| Data-principal rights | Must | UAT evidence for access/export, correction, grievance, consent withdrawal, and lawful erasure/restriction where records are not required to be retained. | 5/5 request scenarios pass; no request without owner/SLA. |
| ABDM/ABHA | Must for ABDM launch | ABDM sandbox credentials, bridge registration, `abdm-preflight` output, M1/M2 dry-run evidence, and NHA certification booking/result where applicable. | M1 and M2 pass before HIP production; M3 pass before HIU production. |
| CERT-In readiness | Must | Security incident SOP with 6-hour reporting path, named CERT-In POC, tabletop run, and 180-day Indian-jurisdiction log evidence. | Detect-to-report tabletop <= 6 hours; logs queryable for >= 180 days. |
| Audit and PHI access logs | Must | Hash-chain verification, PHI access route coverage evidence, privileged-access audit review, and log-redaction proof. | 100% critical PHI reads/writes audited; 0 known unmasked PHI in app/proxy logs. |
| Security closure | Must | Current security checklist, secret rotation evidence, RLS/runtime posture, external pentest or formal exception, image signing/admission policy status. | 0 open Critical/High deployment blockers accepted without signed exception. |
| Backup and DR | Must | Timed restore drill record, RPO/RTO approval, offsite backup encryption evidence, object-lock/versioning decision, downtime drill. | RPO <= 5 min, RTO <= 60 min, restore drill passes clinically meaningful reads. |
| Clinical UAT | Must | Staff role workflow sweep, patient/admin smoke evidence, department UAT scripts, training attendance, downtime back-entry drill. | 100% critical workflows pass; 0 P0/P1 UAT defects open. |
| On-prem network | Must | VLAN/firewall diagram, egress allowlist, no inbound public ports, MFA/VPN/Tailscale policy, endpoint hardening, NTP, EDR/AV policy. | All production assets inventoried; no unmanaged PHI endpoints. |
| Privacy policy and app stores | Must before public apps | Published privacy policy, terms, support/grievance contact, deletion/rights channel, app-store data safety answers. | Policy text matches live telemetry, SDKs, processors, and retention. |
| Clinical AI | Must if enabled | Tenant preflight, pilot evidence pack, human-review policy, no automatic patient dispatch unless approved, local/external model routing decision. | First-pilot evidence pack has no blockers; 100% risky outputs human-reviewed. |
| ISO 27001/SOC 2 style controls | Should | Control matrix, access reviews, vendor register, vulnerability SLAs, change-management evidence, incident postmortem template. | Monthly access review and vuln triage cadence active. |
| Medical-device posture | Counsel/official sign-off | Intended-use statement and CDSCO counsel review if software claims diagnosis, treatment, monitoring, triage, or automated clinical decisioning. | Decision-support disclaimer approved, or CDSCO regulatory path opened. |

## Detailed checklist

### 1. Governance and contracts

- [ ] Hospital legal owner confirms whether VH Health is operated by the
      hospital as Data Fiduciary, VH as processor, or another arrangement.
- [ ] Data-processing agreement covers PHI/PII, sub-processors, breach support,
      log/backup access, deletion/return, audit rights, and cross-border or
      non-India storage if any.
- [ ] Hospital appoints: security incident commander, CERT-In POC, DPDP
      grievance owner, ABDM owner, DR owner, and clinical UAT owner.
- [ ] Risk register includes all open security findings, owner-side actions,
      exceptions, target dates, and compensating controls.
- [ ] Public-facing privacy policy and in-app notices identify categories of
      data, purpose, retention, sharing, grievance channel, and rights request
      channel.

Validation metric: no production tenant is created with `real_patient_data=true`
until all named roles and contracts are linked in the release ticket.

### 2. ABDM/ABHA readiness

Use [`ABDM_READINESS.md`](ABDM_READINESS.md) as the technical source of truth.
Before any ABDM production toggle:

- [ ] NHA sandbox credentials are sealed as `ABDM_CLIENT_ID`,
      `ABDM_CLIENT_SECRET`, `ABDM_CALLBACK_URL`, `ABDM_ENABLED=true`, and the
      selected HIP/HIU identifiers.
- [ ] Bridge registration is complete for the exact facility/software endpoint.
- [ ] Callback host is reachable only through the approved ingress path, and
      callback authenticity/timestamp checks are verified in runtime logs.
- [ ] `node -r dotenv/config apps/backend/scripts/abdm-preflight.mjs` passes in
      the target environment.
- [ ] ABHA link/unlink/verify flows are UAT-tested at the reception desk.
- [ ] Consent grant, deny, revoke, expiry, and purpose/HI-type boundaries are
      tested with sample patients.
- [ ] HIP data push never sends plaintext FHIR bundles; encrypted transfer
      interop is signed off during the M2 dry run.
- [ ] NHA certification evidence is attached before switching from sandbox to
      production ABDM credentials.

Validation metric: 10 representative ABDM journeys pass with no orphan
consents, no plaintext data-push payloads, and no care-context share without a
valid consent artifact.

### 3. DPDP Act and Rules

The DPDP Rules, 2025 have phased commencement. Counsel must map the go-live
date against the sections and rules in force. The platform evidence packet
should still be built now so the hospital can prove readiness:

- [ ] Data inventory covers every PHI/PII table, object bucket, log stream,
      analytics copy, backup, export, and mobile/offline cache.
- [ ] Each processing purpose is mapped to notice, consent, legitimate
      hospital workflow, statutory retention, or another counsel-approved basis.
- [ ] Consent withdrawal is as easy to initiate as consent capture for
      consent-based flows, while legally retained medical records are marked as
      restricted rather than physically deleted where required.
- [ ] Data-principal request SOP covers access, correction, grievance,
      withdrawal, deletion/restriction, nominee/authorized representative, and
      pediatric/guardian cases.
- [ ] Product screens and privacy notices avoid bundled consent for unrelated
      purposes.
- [ ] Sub-processor list covers Cloudflare, Firebase, Sentry, SMS/email
      providers, payment/TPA integrations, AI providers, and any hospital-hosted
      SOC/SIEM.
- [ ] Breach workflow notifies the Data Protection Board and affected Data
      Principals in the form/timing approved by counsel once the applicable
      rules are in force.

Validation metric: run a dry DSAR pack with one inpatient, one OPD patient, one
minor/guardian, one withdrawn-consent patient, and one denied request due to
clinical/legal retention. All five must produce an auditable decision.

### 4. DISHA/NHA-style health data expectations

Treat DISHA as a health-data-specific draft/policy signal unless counsel says a
new binding instrument applies. For production posture, implement the stronger
health-data controls anyway:

- [ ] Health data access is minimum-necessary by role, ward/unit, relationship,
      and emergency override reason.
- [ ] Every break-glass or override writes a tamper-evident audit event.
- [ ] Health data exchange uses consent artifacts and purpose/expiry limits.
- [ ] Patient-facing copy explains what is shared, with whom, why, and for how
      long.
- [ ] Exported health records carry provenance: facility, clinician, timestamp,
      document status, and amendment history.
- [ ] Analytics/AI copies are de-identified or specifically approved for the
      tenant and use case.

Validation metric: sample 30 PHI reads/writes across OPD, IPD, lab, pharmacy,
billing, and ABDM. Every event must have actor, tenant, patient, purpose/path,
timestamp, and request/correlation ID.

### 5. CERT-In security incident readiness

CERT-In Directions require six-hour reporting for qualifying cyber incidents
and secure ICT log retention for a rolling 180 days in Indian jurisdiction.
The existing stack currently documents 30-day Loki retention in some places, so
production requires either increasing primary retention or adding an Indian
archive/SIEM layer before go-live.

- [ ] Named CERT-In POC and alternate are registered in the hospital incident
      plan.
- [ ] Incident taxonomy maps ransomware, data breach/leak, intrusion, DDoS,
      malware, unauthorized access, cloud credential compromise, and human-safety
      impact to the reporting path.
- [ ] Security, application, database, Kubernetes, ingress, firewall, VPN,
      identity, endpoint, and backup logs are retained for at least 180 days in
      Indian jurisdiction.
- [ ] Logs are time-synchronized with NTP and searchable by request ID, user,
      IP/device, patient UID, tenant, and route.
- [ ] Incident tabletop proves detect, severity decision, counsel notification,
      CERT-In report, Data Principal notification decision, containment, and
      evidence preservation.

Validation metric: tabletop clock from "incident noticed" to draft CERT-In
report is <= 6 hours, and a randomly chosen event from 181 days ago can be
retrieved or the archive design is not accepted.

### 6. Audit, logging, and evidence integrity

- [ ] `clinical_audit_events` hash-chain verification passes for the target
      tenant and time window.
- [ ] PHI access middleware covers patient chart, prescriptions, MAR, labs,
      radiology, documents, consents, billing/claims, uploads, ABDM, and AI
      context reads.
- [ ] File/object access logs include user, tenant, patient/context, object key,
      action, and request ID.
- [ ] Admin privileged actions are reviewed weekly during pilot and monthly
      after steady-state.
- [ ] Log-redaction tests cover phone, email, MRN/UID, ABHA, Aadhaar/PAN if
      ever collected, token, OTP, and object URLs.

Validation metric: 100 random sensitive events from the last 7 days reconcile
to a real authenticated actor and tenant; 0 contain raw OTPs, secrets, or
unmasked identifiers in general-purpose logs.

### 7. Backup, DR, and downtime

- [ ] Timed restore drill from [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) is
      complete on the target backup chain.
- [ ] RPO/RTO are signed by hospital leadership and clinical operations.
- [ ] Offsite backup encryption, lifecycle, versioning/object-lock, delete
      protection, and storage jurisdiction are approved by security and counsel.
- [ ] Downtime packs from [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md) have
      been printed, used in a 30-minute drill, and reconciled back into the
      system.
- [ ] Restore evidence includes clinically meaningful reads, not only `SELECT 1`.

Validation metric: RPO <= 5 minutes, RTO <= 60 minutes, 0 unreconciled simulated
downtime medication administrations, and one quarterly drill scheduled.

### 8. Clinical validation and UAT

- [ ] Staff role workflow sweep runs against the deployment candidate with no
      P0/P1 blocker.
- [ ] Admin, patient, staff desktop/mobile, admissions, transfers, MAR,
      pharmacy, lab, radiology, billing, claims, discharge, downtime, and ABDM
      journeys are assigned to hospital UAT owners.
- [ ] Each department signs off its workflow with sanitized or approved pilot
      data.
- [ ] Translation/local-language clinical and consent copy is reviewed by a
      qualified human reviewer.
- [ ] Training attendance and go-live command center roster are attached.
- [ ] Open defects have severity, owner, workaround, and acceptance decision.

Validation metric: 100% critical workflows pass; no P0/P1 open; P2 issues have
signed workarounds and dates.

### 9. Clinical AI and medical-device boundary

Default product posture is clinical decision support with human review, not an
autonomous diagnostic or treatment device. Before enabling any Clinical AI
module:

- [ ] Run `scripts/check-clinical-ai-tenant-preflight.ps1` with
      `-RequirePilotSignoff -RequireNoWarnings` and archive JSON output.
- [ ] Run `scripts/smoke-clinical-ai-pilot-evidence.ps1` and attach the
      redacted evidence pack.
- [ ] Keep risky outputs in review queue; no automatic patient dispatch unless
      hospital clinical governance approves it.
- [ ] Labels distinguish AI output, template fallback, blocked output, and
      schema-unavailable state.
- [ ] External model routing has a DPDP/PHI transfer decision; local Ollama is
      preferred for high-risk PHI-heavy drafts unless counsel approves an
      external processor.
- [ ] Intended-use statement is reviewed. If claims move into diagnosis,
      treatment, monitoring, triage, or autonomous clinical decisioning, pause
      and obtain CDSCO/medical-device counsel.

Validation metric: first-pilot evidence pack has no blockers, all risky module
evals are accepted, and 100% patient-visible content has final human approval.

### 10. On-prem hospital network and endpoint controls

- [ ] 3-node cluster or approved trial exception matches
      [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md).
- [ ] Cluster, management/IPMI, storage, hospital-LAN, and guest networks are
      separated by VLAN/firewall policy.
- [ ] No inbound public hospital firewall ports are required; ingress is via
      approved tunnel/proxy.
- [ ] Egress allowlist covers only required services: ABDM, registry, backups,
      SMS/email/push, monitoring, updates, and approved AI providers.
- [ ] Ward devices use managed OS patching, disk encryption, screen lock, EDR/AV,
      browser policy, and staff offboarding.
- [ ] Time sync is verified for nodes, database, app pods, firewalls, and
      endpoints.

Validation metric: asset inventory covers 100% production nodes, endpoints,
network devices, and service accounts; unmanaged devices cannot reach PHI
routes.

### 11. ISO 27001/SOC 2 style control pack

Formal ISO 27001 or SOC 2 Type II certification is an external audit project,
not a code switch. Before hospital production, maintain a practical control
pack:

- [ ] Asset inventory and data-flow diagrams.
- [ ] Access reviews for admin, database, Kubernetes, GitOps, cloud, and
      support accounts.
- [ ] Change-management record for every production deployment.
- [ ] Vulnerability management with SLA: Critical 72 hours, High 14 days,
      Medium 45 days unless risk-accepted.
- [ ] External penetration test or signed exception.
- [ ] Vendor/sub-processor due diligence and contact list.
- [ ] Incident response postmortem template and retained exercise evidence.

Validation metric: monthly access review and vulnerability triage are scheduled
before pilot; every production change has a rollback and smoke plan.

## Evidence packet layout

For each hospital go-live, attach a dated packet under the project-specific
output folder or release artifact store:

```text
output/india-readiness/<hospital>/<YYYY-MM-DD>/
  00-signoffs/
  01-legal-privacy/
  02-abdm/
  03-dpdp-rights/
  04-cert-in-incident-tabletop/
  05-security-hardening/
  06-audit-log-samples/
  07-backup-dr-downtime/
  08-clinical-uat/
  09-clinical-ai/
  10-network-endpoint/
```

Do not commit real PHI, secrets, production screenshots containing patient data,
or live credentials. Redact evidence before sharing outside the hospital's
approved secure repository.

## Known owner-side blockers to close before real PHI

- ABDM production cannot go live until NHA sandbox/certification evidence is
  complete for the exact HIP/HIU role being enabled.
- CERT-In readiness is not met by 30-day application log retention alone; add
  180-day Indian-jurisdiction security log retention or archive evidence.
- DPDP compliance needs counsel approval because the 2025 Rules have phased
  commencement and hospital-specific role allocation.
- Offsite backup/log storage jurisdiction must be explicitly approved; do not
  assume a provider bucket is India-local without contractual evidence.
- SOC 2 Type II and ISO 27001 certification require external audit/certification
  if a buyer requires the logo/certificate.
- CDSCO/medical-device counsel is required if product claims become diagnostic,
  treatment-directing, monitoring, triage, or autonomous clinical decisioning.
