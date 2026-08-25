// Feedback console — the overview must not publish a KPI nothing can move.
//
// The page used to render a "Response Rate" card from
// `overallStats.responded_count / total_feedback`. Nothing writes
// `feedback.response_status`: the only writer was `respondToFeedback`, which
// INSERTed into a `feedback_responses` table that exists in no migration and
// so raised 42P01 on every call — removed in re-audit lane I (see the removal
// note in services/feedback/feedbackService.js). The card could therefore only
// ever read 0%, which an operator reads as "we answer no one" rather than
// "this platform has no reply feature". The detail panel's "Response:" block
// was dead for the same reason — no endpoint returns reply text for a feedback
// row.
//
// The real service-recovery numbers are on the NPS tab, and those are wired.

import FeedbackPage from "@/app/(with-auth)/dashboard/feedback/page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return {
    ...actual,
    fetchAdminAPI: jest.fn(),
  };
});

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { fetchAdminAPI } from "@/lib/api";

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;

const FEEDBACK_ROW = {
  id: 11,
  patient_name: "Asha K",
  department: "Cardiology",
  rating: 4,
  comment: "Seen on time",
  category: "GENERAL",
  status: "PENDING",
  created_at: "2026-08-20T09:00:00.000Z",
};

function renderPage() {
  // The dashboard reports what the backend actually stores: totals and an
  // average. `responded_count` is deliberately absent — see the header.
  fetchAdminAPIMock.mockImplementation((endpoint: string) => {
    if (endpoint.startsWith("/feedback/recent")) {
      return Promise.resolve({ data: [FEEDBACK_ROW] });
    }
    if (endpoint.startsWith("/feedback/dashboard")) {
      return Promise.resolve({
        data: { overallStats: { total_feedback: 40, average_rating: 4.2 } },
      });
    }
    if (endpoint.startsWith("/quality/nps/dashboard")) {
      return Promise.resolve({ data: { overall: null, urgent_queue: [] } });
    }
    return Promise.resolve({ data: null });
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FeedbackPage />
    </QueryClientProvider>,
  );
}

describe("<FeedbackPage /> overview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("publishes the totals it can actually compute", async () => {
    renderPage();
    expect(await screen.findByText("Total Feedback")).toBeInTheDocument();
    expect(screen.getByText("Average Rating")).toBeInTheDocument();
  });

  it("does not publish a feedback response rate", async () => {
    renderPage();
    await screen.findByText("Total Feedback");
    // The NPS tab owns the only response rate this platform can measure, and
    // it is not rendered on the overview strip.
    expect(screen.queryByText("Response Rate")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
});
