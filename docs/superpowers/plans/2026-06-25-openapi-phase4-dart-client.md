# OpenAPI Phase 4 — Dart Client Codegen (Revive + Gate) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revive the dead Dart codegen so `melos run codegen` produces a valid API client from the now-typed canonical spec, make the existing chopper-client wrapper compile against it, and gate codegen+analyze in Flutter CI.

**Architecture:** `swagger_dart_code_generator` (build_runner) reads the byte-synced `packages/vhhealth_core/swagger/openapi.json` → emits a gitignored chopper client under `lib/api/generated/`; the existing `VHAuthInterceptor` wraps it. Apps are unchanged (still on `VHHttpClient`). The drift gate = CI regenerates the client + analyzes the wrapper against it.

**Tech Stack:** Dart 3.11.x, Flutter 3.41.x, Melos 7.5.1, `swagger_dart_code_generator` 4.1.1 + `chopper` 8.6, build_runner. Spec: `docs/superpowers/specs/2026-06-25-openapi-phase4-dart-client-design.md`.

**Conventions used throughout:**
- All Dart commands run from the repo root unless noted; Melos targets the `vhhealth_core` member (the only one with `build_runner`).
- Codegen: `melos run codegen` = `melos exec --depends-on="build_runner" -- "dart run build_runner build --delete-conflicting-outputs"`. To run only vhhealth_core: `cd packages/vhhealth_core && dart run build_runner build --delete-conflicting-outputs`.
- The generated client is **gitignored** (`packages/vhhealth_core/.gitignore` → `lib/api/generated/`). Never commit it.
- If `dart`/`flutter`/`melos` aren't on PATH, see `docs/tools_local_ci.md` (Flutter 3.41.9 toolchain). Bootstrap once: `dart pub get && melos bootstrap`.

---

## File Structure

**Modify:**
- `packages/vhhealth_core/build.yaml` — generator config (likely already correct; adjust only if T1 shows it must).
- `packages/vhhealth_core/lib/api/vhhealth_api.dart` — barrel; fix the `export` filenames to match what the generator actually emits from `openapi.json`.
- `packages/vhhealth_core/lib/api/vh_auth_interceptor.dart` — wrapper; fix the generated client class name in its doc-comment example + ensure it compiles.
- `packages/vhhealth_core/docs/API_CODEGEN.md` — update the revived-pipeline instructions + actual generated names.
- `packages/vhhealth_core/.gitignore` — fix the stale `swagger/api.yaml` comment (now `swagger/openapi.json`).
- `.github/workflows/_reusable-flutter-workspace.yml` — add the `melos run codegen` step (after format, before analyze).
- `.forgejo/workflows/openapi-client-drift.yml` — Phase-4 codegen step **only if** the Forgejo runner has Dart (else a comment).

**Create:**
- `packages/vhhealth_core/test/api_client_compose_test.dart` — compose smoke test (build the client through the wrapper, no network).

---

## Task 1: Feasibility spike — run codegen on the full spec (DECISION GATE)

**Goal:** Determine whether `swagger_dart_code_generator` handles the full ~2636-path spec, and capture the **actual** generated filenames + client class name (the input is now `openapi.json`, not the old `api.yaml`).

**Files:** none modified (exploratory).

- [ ] **Step 1: Confirm the toolchain is available**

Run:
```bash
dart --version && flutter --version && (melos --version || dart pub global activate melos 7.5.1)
```
Expected: Dart 3.11.x, Flutter 3.41.x, Melos 7.5.x. If missing, install per `docs/tools_local_ci.md` before continuing.

- [ ] **Step 2: Bootstrap the workspace**

Run:
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && dart pub get && melos bootstrap
```
Expected: resolves the pub workspace + bootstraps `vhhealth_core`, `apps/patient`, `apps/staff` with no version conflicts.

- [ ] **Step 3: Confirm the codegen input**

Run:
```bash
ls -1 packages/vhhealth_core/swagger/
```
Expected: exactly `openapi.json` (the Phase-2 byte-synced copy; the old `api.yaml` fork was deleted). If `api.yaml` is present, stop — the sync state is wrong; re-run `npm --prefix apps/backend run openapi:sync-core` from a clean backend spec.

- [ ] **Step 4: Run codegen and TIME it**

Run:
```bash
cd packages/vhhealth_core && time dart run build_runner build --delete-conflicting-outputs 2>&1 | tail -30
```
Expected (the spike's measurement): note (a) success/failure, (b) wall-clock time, (c) any OOM/timeout. Record the result.

- [ ] **Step 5: Inspect the generated output**

Run:
```bash
cd packages/vhhealth_core && ls -1 lib/api/generated/ && wc -l lib/api/generated/*.dart && grep -hoE "class [A-Za-z0-9_]+Service|class [A-Za-z0-9_]+ extends ChopperService|abstract class [A-Za-z0-9_]+ extends ChopperService" lib/api/generated/*.dart | head
```
Expected: the real emitted filenames (likely `openapi.swagger.dart`, `openapi.enums.swagger.dart`, `client_index.dart`) + the generated chopper client class name (likely `Openapi` — swagger_dart_code_generator names it after the input file `openapi.json`, NOT the old `VhhealthApi`/`api.swagger.dart`). **Write down the exact filenames + class name — Task 2 depends on them.**

- [ ] **Step 6: DECISION GATE — full-spec vs typed-subset**

- **If Step 4 succeeded and build time is acceptable (target < ~5 min)** → proceed full-spec. Continue to Task 2.
- **If Step 4 OOM'd / timed out / emitted unusable Dart** → STOP and surface to the user: the full-spec fallback is a curated typed-subset sub-spec (money ops only). Do not implement the fallback without explicit approval (it diverges from the one-canonical-spec D4). Capture the exact failure mode for the user.

(No commit — this task changes no tracked files; `lib/api/generated/` is gitignored.)

### Spike outcome (recorded 2026-06-25 — gate CLOSED: FULL-SPEC)

- **Feasibility: PASS.** `build_runner` ran the full 1.8 MB / 2,636-path spec in **2m7s** (generator itself ~2s; the rest is cold AOT + json_serializable). No OOM/timeout. Output is high-quality: **165 typed model classes** (full money cluster present: `Invoice`/`InvoiceV2`/`Payment`/`Advance`/`CashDrawerSession`/`PaymentLink`/`Refund`/`InvoiceTotals`…), **5,954 typed endpoint methods, zero `Response<dynamic>`**, Prisma `Decimal`→`String`, snake_case `@JsonKey`. Fallback (typed-subset) NOT needed.
- **Actual generated names** (Task 2 uses these): `openapi.swagger.dart` (models + `abstract class Openapi extends ChopperService`, impl `_$Openapi`), `openapi.swagger.g.dart`, `openapi.enums.swagger.dart`, `openapi.metadata.swagger.dart`, `client_index.dart` (`export 'openapi.swagger.dart' show Openapi;`), `client_mapping.dart`. The chopper part `openapi.swagger.chopper.dart` is **NOT written** because of the bug below.
- **`Openapi.create(...)` signature:** `create({ChopperClient? client, http.Client? httpClient, Authenticator? authenticator, ErrorConverter? errorConverter, Converter? converter, Uri? baseUrl, List<Interceptor>? interceptors})`.
- **One blocker bug (fixed in T2 Step 0):** the single FHIR path `/api/v1/fhir/Patient/{id}/$everything` is emitted as `@GET(path: '/api/v1/fhir/Patient/{id}/$everything')` — Dart treats `$everything` as interpolation of an undefined variable → `chopper_generator` throws `FormatException: Not an instance of String.`, skips the `.chopper.dart` part → `_$Openapi` undefined → `dart analyze` reports 6 errors, client won't compile. It is the **only** `$`-prefixed op in the entire spec.

---

## Task 2: Revive — fix the codegen compile bug, then make the barrel + wrapper compile against the regenerated client

**Goal:** Make `melos run codegen` produce a **compiling** chopper client (fix the `$everything` bug), then fix the barrel `export`s + the wrapper to match the actual generated names from Task 1, so `melos run analyze` is clean.

**Files:**
- Modify: `packages/vhhealth_core/build.yaml` (and/or a small build-local sanitizer + the root `melos run codegen` script) — to fix the `$everything` compile bug.
- Modify: `packages/vhhealth_core/lib/api/vhhealth_api.dart`
- Modify: `packages/vhhealth_core/lib/api/vh_auth_interceptor.dart`
- Modify: `packages/vhhealth_core/.gitignore`

- [ ] **Step 0: Fix the `$everything` codegen compile bug (HARD CONSTRAINTS)**

The generated client doesn't compile because of the single FHIR `$everything` path (see Spike outcome). Make `melos run codegen` produce a **compiling** `Openapi`/`_$Openapi` client (`.chopper.dart` part written; `dart analyze` clean on the generated client).

**HARD CONSTRAINTS — do not violate:**
1. **Do NOT modify `apps/backend/src/docs/openapi.json` (canonical) or `packages/vhhealth_core/swagger/openapi.json` (byte-synced core).** They must stay byte-identical — the Phase-2 `check-core-spec-sync.mjs` gate enforces it. The FHIR `$everything` op stays in both specs.
2. The fix must be **local to the Dart codegen pipeline**.
3. **No silent truncation** — if any operation is dropped from the generated client, `log()`/print it during codegen AND note it in `docs/API_CODEGEN.md` (our convention).

**Approach (use superpowers:systematic-debugging; try in order):**
1. Try generator-native `build.yaml` `overriden_requests` to neutralize that one operation's path annotation; regenerate; `dart analyze` the generated client. If it compiles, done.
2. If `overriden_requests` can't escape the `$`-interpolation: add a minimal, documented pre-codegen sanitizer that derives a **build-local, gitignored** codegen input from `swagger/openapi.json` with the single `$`-containing path removed (it has zero Flutter consumers), wire it into the root `melos run codegen` script (sanitize → build_runner), point `build.yaml` at the sanitized input, and `print` the dropped path. `swagger/openapi.json` stays byte-identical to the backend.
3. Whichever path you take, verify: `lib/api/generated/openapi.swagger.chopper.dart` exists, `_$Openapi` resolves, `dart analyze packages/vhhealth_core/lib/api/generated/` (or a full analyze) is error-free on the generated client.

- [ ] **Step 1: Run analyze to see the drift (expected: barrel export errors)**

Run:
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && melos run analyze 2>&1 | grep -iE "vhhealth_api|vh_auth_interceptor|generated/|error" | head
```
Expected: errors in `vhhealth_api.dart` — the `export 'generated/api.swagger.dart'` lines fail because the generator (from `openapi.json`) emitted `openapi.swagger.dart` / `openapi.enums.swagger.dart` instead. (Use Task 1 Step 5's actual filenames.)

- [ ] **Step 2: Fix the barrel exports to the actual filenames**

In `packages/vhhealth_core/lib/api/vhhealth_api.dart`, replace the three `export` lines with the **actual** filenames from Task 1 Step 5. If the generator emitted `openapi.swagger.dart` / `openapi.enums.swagger.dart` / `client_index.dart`:

```dart
// The generator names output files after the input spec: swagger/openapi.json
// produces generated/openapi.swagger.dart + openapi.enums.swagger.dart + the
// chopper client at client_index.dart. Run `melos run codegen` (or
// `dart run build_runner build --delete-conflicting-outputs` in this package)
// after refreshing swagger/openapi.json. See docs/API_CODEGEN.md.
export 'generated/openapi.swagger.dart';
export 'generated/openapi.enums.swagger.dart';
export 'generated/client_index.dart';
```
(If Task 1 showed different names — e.g. no separate `client_index.dart`, or a combined file — use exactly what `ls lib/api/generated/` reported.)

- [ ] **Step 3: Fix the generated client class name in the wrapper doc-comment**

In `packages/vhhealth_core/lib/api/vh_auth_interceptor.dart`, the doc-comment example references `VhhealthApi.create(...)`. Update it to the **actual** generated chopper client class name from Task 1 Step 5 (likely `Openapi`):

```dart
// Install on the generated client:
//
//   final api = Openapi.create(
//     baseUrl: Uri.parse(ApiConfig.baseUrl),
//     interceptors: [VHAuthInterceptor()],
//   );
```
The interceptor *body* needs no change (it only uses chopper's `Interceptor`/`Chain`/`Request`/`Response` types, not the generated client). Verify it still references those.

- [ ] **Step 4: Fix the stale gitignore comment**

In `packages/vhhealth_core/.gitignore`, update the comment that says `swagger/api.yaml`:

```
# OpenAPI codegen output — regenerated on demand from swagger/openapi.json.
# Keeping it out of git means pub get + build_runner must run on fresh
# clones, but avoids ~1 MB of generated churn in diffs and merge conflicts.
lib/api/generated/
```

- [ ] **Step 5: Regenerate + analyze clean**

Run:
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && melos run codegen && melos run analyze 2>&1 | tail -5
```
Expected: codegen succeeds; analyze reports **No issues found** for `vhhealth_core` (generated/ is excluded by `analysis_options.yaml`; the barrel + interceptor now resolve). If analyze still errors on a generated symbol the wrapper uses, fix that symbol reference.

- [ ] **Step 6: Commit**

```bash
git add packages/vhhealth_core/lib/api/vhhealth_api.dart packages/vhhealth_core/lib/api/vh_auth_interceptor.dart packages/vhhealth_core/.gitignore
git commit -m "feat(openapi): revive Dart codegen — barrel + wrapper match openapi.json output"
```

---

## Task 3: Compose smoke test + API_CODEGEN.md

**Goal:** A no-network Dart test that constructs the generated client through `VHAuthInterceptor`, so `melos run test` fails if the generated client API or the wrapper drift apart. Update the codegen docs.

**Files:**
- Create: `packages/vhhealth_core/test/api_client_compose_test.dart`
- Modify: `packages/vhhealth_core/docs/API_CODEGEN.md`

- [ ] **Step 1: Write the compose smoke test**

Create `packages/vhhealth_core/test/api_client_compose_test.dart` (use the **actual** generated client class name from Task 1 — `Openapi` shown here):

```dart
// Compose smoke test (OpenAPI Phase 4): proves the generated chopper client and
// the VHAuthInterceptor wrapper still compose after codegen. No network — it
// only constructs the client, so it fails fast if the generated client's
// `.create()` signature or the interceptor contract drift apart.
import 'package:chopper/chopper.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/api/vhhealth_api.dart';
import 'package:vhhealth_core/api/vh_auth_interceptor.dart';

void main() {
  test('generated client composes with VHAuthInterceptor', () {
    final client = Openapi.create(
      baseUrl: Uri.parse('http://localhost:5000/api/v1'),
      interceptors: const [VHAuthInterceptor()],
    );
    expect(client, isA<ChopperService>());
    expect(const VHAuthInterceptor(), isA<Interceptor>());
  });
}
```
(If `Openapi.create` takes a different parameter shape — e.g. a `ChopperClient` rather than `baseUrl`/`interceptors` directly — match the actual `.create(...)` signature seen in `lib/api/generated/client_index.dart` from Task 1. The test's job is just to construct it.)

- [ ] **Step 2: Run the test (needs the generated client present)**

Run:
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && melos run codegen && cd packages/vhhealth_core && flutter test test/api_client_compose_test.dart 2>&1 | tail -8
```
Expected: PASS. If it fails to compile, the `.create()` signature in the test doesn't match the generated client — fix the test to match `client_index.dart`.

- [ ] **Step 3: Update API_CODEGEN.md**

In `packages/vhhealth_core/docs/API_CODEGEN.md`, update: the generated filenames (`openapi.swagger.dart` etc.), the client class name (`Openapi`), the `melos run codegen` command, and a one-line note that **the generated client is gitignored + regenerated by the Flutter CI codegen step (Phase 4)** — there's no committed baseline to diff; CI regenerates and analyzes. Keep the existing "coexists with VHHttpClient; migrate later" framing.

- [ ] **Step 4: Commit**

```bash
git add packages/vhhealth_core/test/api_client_compose_test.dart packages/vhhealth_core/docs/API_CODEGEN.md
git commit -m "test(openapi): Dart client+wrapper compose smoke test; update API_CODEGEN.md"
```

---

## Task 4: CI codegen gate

**Goal:** Flutter CI regenerates the client and analyzes the wrapper against it, so a spec change that breaks Dart generation or the wrapper fails CI.

**Files:**
- Modify: `.github/workflows/_reusable-flutter-workspace.yml`
- Modify (conditionally): `.forgejo/workflows/openapi-client-drift.yml`

- [ ] **Step 1: Add the codegen step to the GitHub Flutter workflow**

In `.github/workflows/_reusable-flutter-workspace.yml`, insert a codegen step **between** the `Format check` step and the `Analyze` step (codegen MUST run after format — on a fresh clone `lib/api/generated/` does not exist, so the format check only sees hand-written code; running codegen before format would make the format check choke on unformatted generated code):

```yaml
      - name: Format check
        run: melos run format

      - name: Codegen (regenerate Dart client from the synced spec)
        run: melos run codegen

      - name: Analyze
        run: melos run analyze

      - name: Test
        run: melos run test
```

- [ ] **Step 2: Validate the workflow YAML**

Run:
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && node -e "const y=require('js-yaml'); y.load(require('fs').readFileSync('.github/workflows/_reusable-flutter-workspace.yml','utf8')); console.log('YAML OK')" 2>&1 | tail -2
```
Expected: `YAML OK`. (If `js-yaml` isn't resolvable from root, run from `apps/admin` which has it, or use `npx --yes js-yaml .github/workflows/_reusable-flutter-workspace.yml`.)

- [ ] **Step 3: Check whether the Forgejo runner has Dart**

Read `.forgejo/workflows/ci-flutter.yml` (if it exists) or any `.forgejo` workflow that runs `flutter`/`dart`. Run:
```bash
grep -rlE "flutter-action|dart pub|melos" .forgejo/workflows/ 2>/dev/null
```
- **If a Forgejo workflow already provisions Dart/Flutter** → in `.forgejo/workflows/openapi-client-drift.yml`, add a second job (or step) that runs `melos bootstrap && melos run codegen && melos run analyze` for `packages/vhhealth_core/**` changes.
- **If NOT** → add a comment to `.forgejo/workflows/openapi-client-drift.yml` stating the authoritative Dart-client gate is the GitHub `ci-flutter` job (Forgejo keeps spec-sync only). Do not add a Dart step to a runner without the toolchain.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/_reusable-flutter-workspace.yml .forgejo/workflows/openapi-client-drift.yml
git commit -m "ci(openapi): gate Dart client codegen+analyze in Flutter CI (Phase 4)"
```

---

## Task 5: Full verification + finish

- [ ] **Step 1: Full Flutter workspace gate (mirrors CI)**

Run, in order (codegen after format, as CI does):
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && \
melos bootstrap && \
melos run format && \
melos run codegen && \
melos run analyze && \
melos run test 2>&1 | tail -15
```
Expected: bootstrap clean; format clean (hand-written only); codegen succeeds; analyze **No issues found**; tests pass (incl. the new compose smoke test). patient/staff unaffected.

- [ ] **Step 2: Confirm no generated artifact got staged**

Run:
```bash
cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && git status --short packages/vhhealth_core/lib/api/generated/ && echo "(empty = correctly gitignored)"
```
Expected: empty (generated/ stays untracked).

- [ ] **Step 3: Finish the branch**

Merge `--no-ff` → `main`, push `github`; push `origin` (Forgejo) — if the tailnet is offline (0 devices), record it as pending and push when reachable. Delete the branch.

```bash
git checkout main
git merge --no-ff <branch> -m "Merge: OpenAPI Phase 4 — Dart client codegen revive + CI gate"
git push github main && (git push origin main || echo "Forgejo pending — tailnet offline; push origin main when back")
git branch -d <branch>
```

- [ ] **Step 4: Tick ROADMAP + update memory**

- In `docs/ROADMAP.md` §0 T2 #5, mark Phase 4 done (cite the merge SHA): Dart codegen revived from the typed spec, gated in Flutter CI (codegen+analyze), generated client gitignored, apps unmigrated. Note the only remaining OpenAPI work = non-money Phase-5 slices.
- Update memory `project_vh_health_openapi_pipeline.md` + its `MEMORY.md` index line: Phase 4 done, the generated client class name (`Openapi`), the codegen-after-format CI ordering, the spike result (full-spec vs subset), the Forgejo-Dart decision. Commit the ROADMAP change on main; push github (+ origin when reachable).

---

## Self-Review

- **Spec coverage:** revive codegen (T1 spike + T2) ✓; wrapper compiles (T2) ✓; compose smoke test (T3) ✓; API_CODEGEN.md (T3) ✓; CI codegen gate GitHub + Forgejo-conditional (T4) ✓; gitignored-not-committed policy (T2 Step 4 + T3 docs + T5 Step 2) ✓; full-spec risk + decision gate + fallback (T1 Step 6) ✓; closeout/merge/ROADMAP/memory (T5) ✓. No spec requirement unmapped.
- **Placeholder scan:** the only deliberately-deferred concretes are the **actual generated filenames + client class name**, which T1 Step 5 captures and T2/T3 consume — the plan states the expected values (`openapi.swagger.dart`, `Openapi`) and instructs to verify-and-match the generator's real output. This is correct for a codegen-revival (the generator's output names are authoritative), not hand-waving. The typed-subset fallback (T1 Step 6) is explicitly user-gated, not implemented blind.
- **Consistency:** `melos run codegen` / `melos run format` / `melos run analyze` / `melos run test` used identically throughout; the generated client class name placeholder (`Openapi`) flows from T1→T2→T3; codegen-after-format ordering is consistent between T4 (CI) and T5 (local mirror).
- **Ordering safety:** T1 proves feasibility (and gates full-vs-subset) before any file change; T2 makes it compile; T3 adds the test; T4 wires CI in the format→codegen→analyze→test order; T5 verifies + merges. Generated client stays gitignored at every step (T5 Step 2 asserts it).
