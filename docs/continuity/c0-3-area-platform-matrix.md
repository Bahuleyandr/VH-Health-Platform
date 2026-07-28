# C0.3 Hospital-Area and Client-Platform Matrix

**Status:** repository-fact draft — all clinical and support decisions remain blank

**Repository baseline:** `d52daac2c60eb921b327c80c886f35f6e603b528`

**Baseline commit time:** `2026-07-28T13:56:41+05:30`

**Authority:** [implementation plan C0.3](../superpowers/plans/2026-07-28-clinical-service-continuity.md#c03-hospital-area-and-client-platform-impact-matrix), [clinical service continuity design](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md), and [current ward downtime procedure](../DOWNTIME_PROCEDURE.md)

## 1. Reading rules

Repository facts identify existing modules, routes, screens, and visible
dependencies. They do not decide the minimum safe read pack, clinical action
procedure, paper form, identity method, recovery ownership, integration
dependency, drill, or whether an area/platform is included.

Every such cell is deliberately blank. Engineering must not infer coverage
from the presence of a module, a ward bed, a mobile project, or a build
workflow.

The current repository procedure is explicitly a ward-pack procedure and says
ED and OPD are not packaged (`docs/DOWNTIME_PROCEDURE.md:1-6,62-67`).
The generator selects occupied beds joined to ward rows without a clinical-area
discriminator (`apps/backend/src/services/downtime/wardDowntimePackService.js:273-292`).
Mechanical appearance in that query does not prove that ICU, maternity, or any
other specialty has an approved pack.

No Staff, Admin, or Patient client call to `/api/v1/downtime/wards` was found.
The current procedure's “staff-app offline cache feed” label is therefore not
an implemented client feed (`docs/DOWNTIME_PROCEDURE.md:21-25`).

## 2. Hospital areas

### 2.1 Ward

| Repository fact | Evidence |
|---|---|
| Staff has `/ward-mode`; its workbench links command board, beds, nursing notes, due medication, handover, IP records, investigations, prescriptions, and discharge. | `apps/staff/lib/core/navigation/app_router.dart:437`; `apps/staff/lib/features/ward/screens/ward_mode_screen.dart:157-259` |
| Backend ward/bed, admission, transfer, discharge, MAR, and handover routes exist. | `apps/backend/src/app.js:875-877`; `apps/backend/src/routes/bed/bedRoutes.js:41-58`; `apps/backend/src/routes/emr/admissionRoutes.js:120-214,654-680`; `apps/backend/src/routes/clinical/clinicalRoutes.js:256-290,461-499` |
| Admin has cross-cutting Beds, MAR, and nursing-assessment pages rather than a dedicated ward page. Patient has no ward module/route. | `apps/admin/src/app/(with-auth)/dashboard/beds/page.tsx:114-155`; `apps/admin/src/app/(with-auth)/dashboard/mar/page.tsx:75-87`; `apps/admin/src/app/(with-auth)/dashboard/nursing-assessments/page.tsx:83-115`; `apps/patient/lib/core/navigation/app_router.dart:467-471` |
| Current packs directly cover occupied-bed wards and draw on ward/bed census, admissions, allergies, MAR, orders, and vitals. The repository does not contain a client consumer of the JSON feed, and durable LAN mirror delivery is not proven. | `docs/DOWNTIME_PROCEDURE.md:8-25,60-67`; `apps/backend/src/services/downtime/wardDowntimePackService.js:178-247,273-338`; `infra/kubernetes/apps/backend/ward-downtime-packs-cronjob.yaml:118-134` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.2 Emergency department (ED)

| Repository fact | Evidence |
|---|---|
| Staff has `/ed-trauma` and an ED/trauma workbench for policy, trauma survey, encounter evidence, destination handoff, continuity/transition, closure, and recovery. | `apps/staff/lib/core/navigation/app_router.dart:443`; `apps/staff/lib/core/services/ed_trauma_api_service.dart:8-56,138-194` |
| Backend ED routes cover visits, transition/closure/recovery, destination handoffs, triage, trauma/MLC, ambulance, and prehospital handover/device links. | `apps/backend/src/app.js:882-888`; `apps/backend/src/routes/admin/edRoutes.js:175-332,444-481,595-806` |
| Admin has an ED tracker. Patient has no ED chart/board module; SOS and symptom-checker surfaces are adjacent but are not an ED record. | `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx:152-187,667`; `apps/patient/lib/core/services/sos_api_service.dart:21`; `apps/patient/lib/features/chatbot/screens/symptom_checker_screen.dart:40` |
| The ward downtime procedure explicitly says ED is not packaged. Visible integrations include ambulance/prehospital inputs, event outbox, and destination handoffs to inpatient/critical-care/surgery/external transfer domains. | `docs/DOWNTIME_PROCEDURE.md:62-67`; `apps/backend/src/services/ed/ambulancePrehospitalService.js:3-13`; `apps/backend/src/services/ed/edDestinationHandoffService.js:39` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.3 Outpatient department (OPD)

| Repository fact | Evidence |
|---|---|
| Staff has doctor workspace, nursing dashboard, and appointment-queue routes. The doctor workspace uses timeline/notes/pathway work, prescriptions, closure evidence, inpatient transfer, and completion. | `apps/staff/lib/core/navigation/app_router.dart:269,482,507`; `apps/staff/lib/features/opd/screens/op_doctor_workspace_screen.dart:234-286,470,716-921` |
| Backend appointment routes cover queues, slots, walk-ins, pathway work, closure evidence, inpatient transfer, completion, and advise-admission; EMR notes/timeline/orders/vitals are separate mounts. | `apps/backend/src/app.js:758,1104-1142`; `apps/backend/src/routes/appointment/appointmentWorkflowRoutes.js:56-152` |
| Admin exposes appointments, doctor queue, walk-in registration, and queue displays rather than a dedicated OPD page. Patient exposes appointments and appointment-bound teleconsultation, not an OPD workbench. | `apps/admin/src/app/(with-auth)/dashboard/appointments/page.tsx:21-114`; `apps/admin/src/lib/api/queueDisplays.ts:61-73`; `apps/patient/lib/core/navigation/app_router.dart:315-358` |
| The ward downtime procedure explicitly says OPD is not packaged. Visible dependencies include appointments, doctors/departments, EMR timeline/notes, prescriptions, pathway closure, OP-to-IP handoff, and the configured teleconsultation service for applicable visits. | `docs/DOWNTIME_PROCEDURE.md:62-67`; `apps/backend/src/services/telemedicine/teleconsultProvisioningService.js:5,89-102` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.4 Theatre / operating room

| Repository fact | Evidence |
|---|---|
| Staff has `/theatre`; its API covers schedule, room availability, scheduling/status, checklist, and surgical-safety phases. | `apps/staff/lib/core/navigation/app_router.dart:1033`; `apps/staff/lib/core/services/theatre_api_service.dart:50-93` |
| Backend mounts theatre, anesthesia, CSSD, and surgical modules with scheduling, OR board, anesthesia chart, pre/intra/post-operative documentation, implants, WHO phases, and complications. | `apps/backend/src/app.js:1275-1296`; `apps/backend/src/routes/theatre/theatreRoutes.js:29-130`; `apps/backend/src/routes/theatre/orBoardRoutes.js:49-80`; `apps/backend/src/routes/theatre/anesthesiaChartRoutes.js:37`; `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js:64-426` |
| Admin has Theatre, OR Board, and Anesthesia Chart pages. Patient has no dedicated theatre/OR route. | `apps/admin/src/app/(with-auth)/dashboard/theatre/page.tsx:401`; `apps/admin/src/app/(with-auth)/dashboard/or-board/page.tsx:96`; `apps/admin/src/app/(with-auth)/dashboard/anesthesia-chart/page.tsx:75` |
| There is no theatre-specific downtime pack. Ward-pack payload does not include theatre schedule, room, checklist, anesthesia, implant, or complication objects. Visible dependencies include CSSD, consent, blood readiness, imaging, pre-op laboratory data, and realtime board events. | `apps/backend/src/services/downtime/wardDowntimePackService.js:178-247`; `apps/backend/src/services/theatre/theatreService.js:10`; `apps/backend/src/routes/admin/surgicalDocumentationRoutes.js:82-95` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.5 ICU / NICU / PICU

| Repository fact | Evidence |
|---|---|
| Staff has no dedicated ICU/NICU/PICU route; ICU and NICU/PICU panels are embedded in the patient command board. The neonatal panel renders feed/fluid, respiratory, cardiorespiratory, phototherapy, thermal, newborn, growth, and score data. | `apps/staff/lib/features/emr/screens/patient_command_board_screen.dart:1348-1352`; `apps/staff/lib/features/emr/widgets/nicu_picu_chart_panel.dart:5-34` |
| Backend ICU routes cover admissions/from-ER, charts, ventilation/weaning, lines, scores, devices, neonatal chart/settings, feed/fluid, respiratory/cardiorespiratory/phototherapy/thermal observations, newborn links, flowsheet, assessments, and bundle. | `apps/backend/src/app.js:1307`; `apps/backend/src/routes/clinical/icuRoutes.js:49-752` |
| Admin has an ICU command centre; NICU/PICU appear as unit values rather than dedicated pages. Patient has no ICU/NICU/PICU module. | `apps/admin/src/app/(with-auth)/dashboard/icu/page.tsx:3-55`; `apps/admin/src/app/(with-auth)/dashboard/icu/components/AdmissionsTab.tsx:260` |
| No critical-care-specific pack exists. A unit can be selected mechanically only if represented as an occupied ward bed, while critical-care device, ventilation, line, flowsheet, assessment, neonatal, and score objects are absent from the ward-pack payload. Visible dependencies include ER-to-ICU continuation, device observations, and maternity newborn identity. | `apps/backend/src/services/downtime/wardDowntimePackService.js:178-292`; `apps/backend/src/routes/clinical/icuRoutes.js:67,356`; `apps/backend/src/services/clinical/nicuPicuChartingService.js:982-999` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.6 Maternity

| Repository fact | Evidence |
|---|---|
| Staff has maternity, partograph-entry, and partograph-chart routes; the screen lists active labour admissions and links chart/entry work. | `apps/staff/lib/core/navigation/app_router.dart:1082-1097`; `apps/staff/lib/features/maternity/screens/maternity_screen.dart:79,249-259` |
| Backend maternity routes cover pregnancy, ANC, labour admission, partograph, delivery, newborn/APGAR, postnatal visits, and newborn immunisation. | `apps/backend/src/app.js:1399`; `apps/backend/src/routes/maternity/maternityRoutes.js:68-224` |
| Admin lists active labour admissions and partograph history. Patient has an ANC timeline surface, not labour, partograph, delivery, newborn-chart, or postnatal workbenches. | `apps/admin/src/app/(with-auth)/dashboard/maternity/page.tsx:72,176-187`; `apps/patient/lib/core/navigation/app_router.dart:488`; `apps/patient/lib/features/maternity/services/maternity_repository.dart:24-133` |
| No maternity-specific downtime pack exists. A patient can be selected mechanically only when assigned to an occupied ward bed; pregnancy, labour, partograph, delivery, and newborn objects are absent. Visible dependencies include appointments, investigations/prescriptions, newborn immunisation, and NICU newborn linking. | `apps/backend/src/services/downtime/wardDowntimePackService.js:178-292`; `apps/backend/src/services/maternity/maternityService.js:821-881`; `apps/backend/src/services/clinical/nicuPicuChartingService.js:984` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.7 Cath lab

| Repository fact | Evidence |
|---|---|
| Staff has `/cath-lab` and a dedicated Cath Lab screen. | `apps/staff/lib/core/navigation/app_router.dart:1041-1044`; `apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart:57-83` |
| Backend Cath Lab routes cover scheduling/cases, reports/viewer links, readiness/order sets, procedure logs, hemodynamics, radiation/contrast, post-orders, and device links. | `apps/backend/src/app.js:1319`; `apps/backend/src/routes/clinical/cathLabRoutes.js:54-471`; `apps/backend/src/routes/clinical/cathSchedulingRoutes.js:65-112` |
| Admin has cath quality and consumables/finance views rather than a duplicate operational case workbench. Patient has no dedicated cath route. | `apps/admin/src/app/(with-auth)/dashboard/quality/cath/page.tsx:19-52`; `apps/admin/src/app/(with-auth)/dashboard/billing/cath-consumables/page.tsx:16-35` |
| No Cath Lab downtime pack or Staff enqueue call exists. Visible dependencies include blood-bank crossmatch, consent, order sets, PACS/DICOM viewer links, pharmacy inventory, and billing. | `apps/backend/src/services/clinical/cathQuickWinsService.js:1-4,69-244`; `apps/backend/src/services/clinical/cathReportService.js:899-941`; `apps/backend/src/services/clinical/cathLabService.js:1141-1153,1419-1424,2183-2311` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.8 Dialysis

| Repository fact | Evidence |
|---|---|
| Backend Dialysis routes cover patient roster/prescription/access, sessions, observations/events, reuse register, machine QA/ingest, and serology. | `apps/backend/src/app.js:1318`; `apps/backend/src/routes/clinical/dialysisRoutes.js:38-243` |
| Admin has a dedicated realtime unit board. Staff and Patient have no dedicated tracked Dialysis module or route. | `apps/admin/src/app/(with-auth)/dashboard/dialysis/page.tsx:16-78`; `apps/admin/src/app/(with-auth)/dashboard/dialysis/components/RosterTab.tsx:25-33`; `apps/admin/src/app/(with-auth)/dashboard/dialysis/components/SessionTab.tsx:39-65` |
| No Dialysis client enqueue site or downtime pack exists. Visible dependencies include machine payloads through the interface inbox/observation path, billing at completion, and realtime board events. | `apps/backend/src/services/clinical/dialysisMachineService.js:3-12,46-122`; `apps/backend/src/services/clinical/dialysisService.js:610-621,834-919`; `apps/backend/src/utils/websocket/realtimeEmitter.js:305-310` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.9 Pharmacy

| Repository fact | Evidence |
|---|---|
| Backend Pharmacy routers cover orders, medications, inventory, administration, ward indents, controlled dispense, registers, movements, and expiry operations. | `apps/backend/src/app.js:770-779`; `apps/backend/src/routes/pharmacy/index.js:49-69`; `apps/backend/src/routes/pharmacy/inventoryV2Routes.js:96-147` |
| Staff and Patient each have `/pharmacy`; Admin has Pharmacy overview/orders/catalog/schedule/expiry and inventory pages. | `apps/staff/lib/core/navigation/app_router.dart:356-359`; `apps/admin/src/app/(with-auth)/dashboard/pharmacy/page.tsx:55-69`; `apps/admin/src/app/(with-auth)/dashboard/pharmacy/inventory/page.tsx:44-59`; `apps/patient/lib/core/navigation/app_router.dart:377-378` |
| Pharmacy screens themselves contain no enqueue call. Related prescribing and inpatient medication-order screens do enqueue production create routes; Patient pharmacy writes are direct network calls. | `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart:1014-1066`; `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart:172-218`; `apps/patient/lib/features/pharmacy/widgets/order_form_tab.dart:186-190` |
| No Pharmacy-specific downtime pack exists. Ward packs expose only selected medication/order context and do not establish dispensing, stock, controlled-drug, indent, or delivery continuity. | `apps/backend/src/services/downtime/wardDowntimePackService.js:178-247` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.10 Laboratory

| Repository fact | Evidence |
|---|---|
| Backend Laboratory routes cover analyzer/interface ingest, orders, sample/barcode/rejection, results, worklists, sign-off, critical alerts, labels, receive scan, and interface inbox. | `apps/backend/src/app.js:1343,1349-1352`; `apps/backend/src/routes/lab/labIngestRoutes.js:65-109`; `apps/backend/src/routes/lab/labRoutes.js:107-203,223-378` |
| Staff has lab booking and specimen-scan routes. Admin has lab sign-off/critical-alert and broader investigations pages. Patient has portal lab order/result routes and encrypted result-cache reads. | `apps/staff/lib/core/navigation/app_router.dart:335-352`; `apps/admin/src/app/(with-auth)/dashboard/lab/page.tsx:505-535`; `apps/admin/src/app/(with-auth)/dashboard/investigations/page.tsx:21-53`; `apps/patient/lib/core/navigation/app_router.dart:397-401,463-464`; `apps/patient/lib/features/portal/services/lab_results_repository.dart:23-63` |
| Staff specimen collection is the area's only active offline enqueue action and targets the authoritative collection route. | `apps/staff/lib/features/investigations/screens/specimen_scan_screen.dart:65-106`; `apps/staff/lib/features/investigations/specimen_scan_intent.dart:19-56` |
| No Laboratory-specific downtime pack exists. Visible dependencies include analyzers/HL7 and non-HL7 ingest, order/worklist state, patient-result release, critical-alert handling, and specimen chain of custody. | `apps/backend/src/routes/lab/labIngestRoutes.js:65-109`; `apps/backend/src/routes/lab/labRoutes.js:107-378` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

### 2.11 Blood bank

| Repository fact | Evidence |
|---|---|
| Backend Blood Bank routes cover donor/screening/deferral/donation/consent, component processing, traceability/registers, requests, crossmatch, issue, bedside verification, transfusion, reactions, inventory, and pending queues. | `apps/backend/src/app.js:1322`; `apps/backend/src/routes/bloodbank/bloodBankRoutes.js:67-453` |
| Staff has Blood Bank and bedside-scan routes; Admin has a full Blood Bank dashboard. Patient has no dedicated Blood Bank route. | `apps/staff/lib/core/navigation/app_router.dart:968-987`; `apps/staff/lib/features/bloodbank/screens/blood_bank_screen.dart:20-47,77-151`; `apps/admin/src/app/(with-auth)/dashboard/blood-bank/page.tsx:1350-1364` |
| Bedside transfusion verification is the area's only active offline enqueue action. Realtime board events exist, but they are not a durable replay contract. | `apps/staff/lib/features/bloodbank/screens/transfusion_scan_screen.dart:69-112`; `apps/staff/lib/features/bloodbank/transfusion_scan_intent.dart:19-61`; `apps/backend/src/utils/websocket/realtimeEmitter.js:314-319` |
| No Blood Bank-specific downtime pack exists. Ward medication/order context does not establish donor, compatibility, issue, witness, unit traceability, reaction, or inventory continuity. | `apps/backend/src/services/downtime/wardDowntimePackService.js:178-247`; `apps/backend/src/routes/bloodbank/bloodBankRoutes.js:67-453` |

| Required owner-input field | Decision/value |
|---|---|
| Minimum read pack | OWNER INPUT — intentionally blank; engineering must not fill |
| Action procedure | OWNER INPUT — intentionally blank; engineering must not fill |
| Paper form | OWNER INPUT — intentionally blank; engineering must not fill |
| Identity method | OWNER INPUT — intentionally blank; engineering must not fill |
| Recovery owner | OWNER INPUT — intentionally blank; engineering must not fill |
| Integration dependency | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill | OWNER INPUT — intentionally blank; engineering must not fill |
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill |

## 3. Client-platform decisions

The platform rows are independent decisions. A support decision for one client
does not approve another client or its PHI storage model.

| Platform | Current repository facts | Offline storage and release facts | Support decision |
|---|---|---|---|
| Android | Staff and Patient have committed Android projects and release workflows (`.github/workflows/release-staff.yml:74-110`; `.github/workflows/release-patient.yml:75-110`). | Staff uses native SQLite for the encrypted, owner-scoped queue and platform secure storage for keys (`packages/vhhealth_core/lib/services/offline_queue.dart:14-58,142-167`; `packages/vhhealth_core/lib/services/secure_storage.dart:19-25,35-40,63-65`). | OWNER INPUT — intentionally blank; engineering must not fill |
| Windows / desktop | Both apps have Windows runner scaffolds; only Staff has a repository Windows/MSIX release path, whose production signing remains operator work (`.github/workflows/release-staff.yml:112-195`; `apps/staff/pubspec.yaml:81-89`). | Staff initializes `sqflite_common_ffi` for desktop queue access. Secure storage uses platform-plugin behavior (`apps/staff/lib/main.dart:83-90`; `packages/vhhealth_core/lib/services/secure_storage.dart:79-80`). Patient has no Windows release workflow. | OWNER INPUT — intentionally blank; engineering must not fill |
| Browser / web | Repository browser builds include Next.js Admin and a Flutter Staff Web deployment intended/labelled for LAN use (`.github/workflows/release-images.yml:506-570`; `infra/kubernetes/apps/staff-web/deployment.yaml:1-13,49-63`). Its Ingress selects `nginx-internal`, but the vendored controller watches the different `nginx` class, so the internal route is currently unroutable/unproven (`infra/kubernetes/apps/staff-web/ingress.yaml:34-42`; `infra/kubernetes/base/ingress-nginx/ingress-nginx.yaml:295-305,355-405`). Admin removes service workers/browser caches and has no offline clinical cache (`apps/admin/src/components/ServiceWorkerCleanup.tsx:5-25`). | Staff's queue unconditionally imports/uses native `sqflite`; startup notes web is unsupported but still starts sync without a web queue guard (`packages/vhhealth_core/lib/services/offline_queue.dart:7,142-150`; `apps/staff/lib/main.dart:83-90,215-217`). No IndexedDB/web adapter exists. Browser storage therefore cannot reuse or be assumed equivalent to the SQLite queue. | OWNER INPUT — intentionally blank; engineering must not fill |
| iOS | Staff and Patient have committed iOS projects, but no GitHub workflow builds or publishes iOS artifacts. Repository scripting leaves schemes, Firebase configuration, and signing to operators (`scripts/build-tenant-client.sh:14-17,57-59`). | Native Staff iOS would use the shared SQLite queue and Keychain-backed secure storage (`packages/vhhealth_core/lib/services/secure_storage.dart:23-25,42-48,66-70`). That code presence does not prove a released or approved client. | OWNER INPUT — intentionally blank; engineering must not fill |

### Platform owner-input detail

| Required owner-input field | Android | Windows / desktop | Browser / web | iOS |
|---|---|---|---|---|
| Included / manual-only / excluded | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill |
| Permitted read-pack behavior | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill |
| Permitted mutation behavior | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill |
| PHI storage/security approval | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill |
| Release/support owner | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill |
| Drill and evidence | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill | OWNER INPUT — intentionally blank; engineering must not fill |

## 4. Completion boundary

This matrix names all eleven required hospital areas and all four required
client platforms. None is implicitly included. A hospital-wide or
platform-wide continuity claim may cover only rows whose owner-input fields are
completed and approved; all other rows remain outside the claim.
