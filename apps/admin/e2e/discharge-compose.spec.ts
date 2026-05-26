import { expect, test, type Page, type Route } from "@playwright/test";

const DISCHARGE_COMPOSE_API =
  "**/api/proxy/api/v1/admin/clinical-ai/discharge-compose**";

function envelope(data: unknown) {
  return JSON.stringify({ success: true, data });
}

async function fulfillJson(route: Route, data: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: envelope(data),
  });
}

const pausedRun = {
  id: 501,
  tenant_id: "tenant-playwright",
  workflow_key: "discharge_summary_compose",
  module_key: null,
  patient_uid: "PAT-AI-501",
  admission_id: 8801,
  status: "paused",
  current_node: "await_governance",
  pause_reason: "await_governance",
  started_at: "2026-05-25T09:00:00.000Z",
  paused_at: "2026-05-25T09:03:00.000Z",
  completed_at: null,
  failed_at: null,
  metadata: {
    overall_safety_band: "high",
    compose_children: [
      "medication_reconciliation",
      "patient_aftercare_instructions",
    ],
  },
};

const completedRun = {
  id: 502,
  tenant_id: "tenant-playwright",
  workflow_key: "discharge_summary_compose",
  module_key: null,
  patient_uid: "PAT-AI-502",
  admission_id: 8802,
  status: "completed",
  current_node: "done",
  pause_reason: null,
  started_at: "2026-05-25T10:00:00.000Z",
  paused_at: null,
  completed_at: "2026-05-25T10:05:00.000Z",
  failed_at: null,
  metadata: {
    overall_safety_band: "ok",
    compose_children: ["clinical_coding_assist"],
  },
};

function detailFor(status: "paused" | "completed", id = 501) {
  const baseRun = id === 601 ? startedRunListItem : pausedRun;
  const run = {
    ...baseRun,
    id,
    status,
    current_node: status === "paused" ? "await_governance" : "done",
    pause_reason: status === "paused" ? "await_governance" : null,
    state: { admission_id: baseRun.admission_id },
    result: {
      module_key: "discharge_summary_compose",
      admission_id: baseRun.admission_id,
      compose_generation_id: status === "completed" ? 9901 : null,
      overall_safety_band: status === "paused" ? "high" : "ok",
      compose_children: [
        "medication_reconciliation",
        "patient_aftercare_instructions",
      ],
      components: {},
      child_generation_ids: status === "completed" ? [7101, 7102] : [],
      critical_safety_flags:
        status === "paused"
          ? [
              {
                severity: "critical",
                code: "PILOT_SIGNOFF_REQUIRED",
                message: "Pilot signoff must be approved before rollout.",
              },
            ]
          : [],
      requires_signoff: true,
    },
    error_node: null,
    error_message: null,
    checkpoints: [
      {
        node: "load_context",
        started_at: "2026-05-25T09:00:00.000Z",
        completed_at: "2026-05-25T09:00:01.000Z",
        duration_ms: 1000,
        status: "completed",
      },
      {
        node: "await_governance",
        started_at: "2026-05-25T09:02:00.000Z",
        duration_ms: 0,
        status: status === "paused" ? "paused" : "completed",
        reason: status === "paused" ? "await_governance" : undefined,
      },
    ],
    parent_run_id: null,
    parent_node: null,
    updated_at: "2026-05-25T09:03:00.000Z",
  };

  return {
    run,
    child_count: 2,
    children: [
      {
        id: 7101,
        tenant_id: "tenant-playwright",
        workflow_key: "clinical_ai_generation",
        module_key: "medication_reconciliation",
        patient_uid: "PAT-AI-501",
        admission_id: baseRun.admission_id,
        status: "completed",
        current_node: "done",
        pause_reason: null,
        parent_run_id: id,
        parent_node: "medication_reconciliation",
        started_at: "2026-05-25T09:00:01.000Z",
        completed_at: "2026-05-25T09:01:01.000Z",
        failed_at: null,
        paused_at: null,
      },
      {
        id: 7102,
        tenant_id: "tenant-playwright",
        workflow_key: "clinical_ai_generation",
        module_key: "patient_aftercare_instructions",
        patient_uid: "PAT-AI-501",
        admission_id: baseRun.admission_id,
        status,
        current_node: status === "paused" ? "await_governance" : "done",
        pause_reason: status === "paused" ? "await_governance" : null,
        parent_run_id: id,
        parent_node: "patient_aftercare_instructions",
        started_at: "2026-05-25T09:01:01.000Z",
        completed_at:
          status === "completed" ? "2026-05-25T09:02:01.000Z" : null,
        failed_at: null,
        paused_at: status === "paused" ? "2026-05-25T09:03:00.000Z" : null,
      },
    ],
  };
}

const startedRunListItem = {
  ...pausedRun,
  id: 601,
  admission_id: 9901,
  patient_uid: "PAT-AI-601",
};

async function mockDischargeComposeApi(page: Page) {
  let resumed = false;
  let started = false;
  const startBodies: unknown[] = [];

  await page.route(DISCHARGE_COMPOSE_API, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === "POST" && path.endsWith("/resume")) {
      resumed = true;
      await fulfillJson(route, {
        status: "completed",
        runId: 501,
        state: {},
        result: detailFor("completed").run.result,
      });
      return;
    }

    if (method === "POST" && path.endsWith("/discharge-compose")) {
      started = true;
      startBodies.push(request.postDataJSON());
      await fulfillJson(route, {
        module_key: "discharge_summary_compose",
        admission_id: 9901,
        run_id: 601,
        status: "paused",
        pause_reason: "await_governance",
        message: "Awaiting governance approval",
      });
      return;
    }

    if (method === "GET" && /\/discharge-compose\/\d+$/.test(path)) {
      const runId = Number(path.split("/").at(-1));
      const status = resumed ? "completed" : "paused";
      await fulfillJson(route, detailFor(status, runId));
      return;
    }

    if (method === "GET" && path.endsWith("/discharge-compose")) {
      const status = url.searchParams.get("status");
      const runs = started
        ? [
            startedRunListItem,
            resumed ? { ...pausedRun, status: "completed" } : pausedRun,
          ]
        : status === "paused"
          ? [pausedRun]
          : [pausedRun, completedRun];
      await fulfillJson(route, { runs, count: runs.length });
      return;
    }

    await route.fallback();
  });

  return { startBodies };
}

test.describe("authenticated — discharge compose admin workflow", () => {
  test("renders run list, filters paused runs, opens detail, and resumes governance-paused runs", async ({
    page,
  }) => {
    await mockDischargeComposeApi(page);

    await page.goto("/dashboard/clinical-ai/discharge-compose");

    await expect(
      page.getByRole("heading", { name: "Discharge Compose" }),
    ).toBeVisible();
    await expect(page.getByText("Recent runs")).toBeVisible();
    await expect(page.getByRole("button", { name: /Run #501/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run #502/ })).toBeVisible();

    await page.getByRole("button", { name: "Paused" }).click();
    await expect(page.getByRole("button", { name: /Run #501/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run #502/ })).toHaveCount(0);

    await page.getByRole("button", { name: /Run #501/ }).click();
    await expect(page.getByText("Critical safety flags")).toBeVisible();
    await expect(page.getByText("PILOT_SIGNOFF_REQUIRED")).toBeVisible();
    await expect(page.getByText("medication_reconciliation")).toBeVisible();
    await expect(
      page.getByText("patient_aftercare_instructions"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText("Run #501 completed.")).toBeVisible();
    await expect(page.getByText("COMPLETED")).toBeVisible();
  });

  test("starts a fresh compose with the typed admission ID", async ({
    page,
  }) => {
    const api = await mockDischargeComposeApi(page);

    await page.goto("/dashboard/clinical-ai/discharge-compose");

    await page.getByPlaceholder("Admission ID").fill("9901");
    await page.getByRole("button", { name: "Start compose" }).click();

    await expect(
      page.getByText("Compose paused: await_governance"),
    ).toBeVisible();
    expect(api.startBodies).toEqual([{ admission_id: 9901 }]);
    await expect(page.getByText("Run #601")).toBeVisible();
  });
});
