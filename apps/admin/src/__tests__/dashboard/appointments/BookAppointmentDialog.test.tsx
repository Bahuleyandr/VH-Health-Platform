import { BookAppointmentDialog } from "@/app/(with-auth)/dashboard/appointments/components/BookAppointmentDialog";
import { fetchAdminAPI } from "@/lib/api";
import { bookAppointmentAdmin } from "@/lib/api/appointments";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));
jest.mock("@/lib/api/appointments", () => ({
  bookAppointmentAdmin: jest.fn(),
}));

const fetchAdminAPIMock = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;
const bookAppointmentAdminMock = bookAppointmentAdmin as jest.MockedFunction<
  typeof bookAppointmentAdmin
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    ["appointment-doctor-options"],
    [{ id: 7, name: "Dr Example" }],
  );
  return render(
    <QueryClientProvider client={client}>
      <BookAppointmentDialog onClose={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  );
}

describe("<BookAppointmentDialog /> patient identity lookup", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchAdminAPIMock.mockReset();
    bookAppointmentAdminMock.mockReset();
    bookAppointmentAdminMock.mockResolvedValue({} as never);
    (toast.error as jest.Mock).mockClear();
    fetchAdminAPIMock.mockImplementation((path) => {
      if (String(path).startsWith("/appointments/doctors/options")) {
        return Promise.resolve({
          doctors: [{ id: 7, name: "Dr Example" }],
        }) as ReturnType<typeof fetchAdminAPI>;
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("ignores an older phone lookup that resolves after the current lookup", async () => {
    const firstLookup = deferred<{ patients: Array<{ id: number; name: string; phone: string }> }>();
    const secondLookup = deferred<{ patients: Array<{ id: number; name: string; phone: string }> }>();
    fetchAdminAPIMock.mockImplementation((path) => {
      const requestPath = String(path);
      if (requestPath.startsWith("/appointments/doctors/options")) {
        return Promise.resolve({
          doctors: [{ id: 7, name: "Dr Example" }],
        }) as ReturnType<typeof fetchAdminAPI>;
      }
      if (requestPath.includes("9000000001")) {
        return firstLookup.promise as ReturnType<typeof fetchAdminAPI>;
      }
      if (requestPath.includes("9000000002")) {
        return secondLookup.promise as ReturnType<typeof fetchAdminAPI>;
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    });

    renderDialog();
    expect(screen.getByRole("option", { name: "Dr Example" })).toBeInTheDocument();
    const phone = screen.getByPlaceholderText("10 digit mobile number");

    fireEvent.change(phone, { target: { value: "9000000001" } });
    act(() => jest.advanceTimersByTime(450));
    fireEvent.change(phone, { target: { value: "9000000002" } });
    act(() => jest.advanceTimersByTime(450));

    await act(async () => {
      secondLookup.resolve({
        patients: [{ id: 22, name: "Patient B", phone: "+919000000002" }],
      });
      await secondLookup.promise;
    });
    expect(screen.getByText("Existing patient found: #22")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Patient B")).toBeInTheDocument();

    await act(async () => {
      firstLookup.resolve({
        patients: [{ id: 11, name: "Patient A", phone: "+919000000001" }],
      });
      await firstLookup.promise;
    });

    expect(screen.getByText("Existing patient found: #22")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Patient B")).toBeInTheDocument();
    expect(screen.queryByText("Existing patient found: #11")).not.toBeInTheDocument();

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByPlaceholderText("Consultation reason"), {
      target: { value: "Review visit" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Book" }));
    });

    expect(bookAppointmentAdminMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patient_id: 22,
        patient_phone: "9000000002",
      }),
    );
  });

  it("does not submit until lookup has completed for the current phone", () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText("10 digit mobile number"), {
      target: { value: "9000000003" },
    });
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByPlaceholderText("Consultation reason"), {
      target: { value: "Review visit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Book" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Patient lookup must succeed before booking",
    );
    expect(bookAppointmentAdminMock).not.toHaveBeenCalled();
  });
});
