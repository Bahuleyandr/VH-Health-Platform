
import { CreateAdminForm } from "@/app/(with-auth)/dashboard/admin-management/components/CreateAdminForm";
import { postJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/lib/api", () => ({
  postJSON: jest.fn(),
}));

const mockedPostJSON = postJSON as jest.MockedFunction<typeof postJSON>;

describe("<CreateAdminForm />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPostJSON.mockResolvedValue({});
  });

  it("creates a new admin via POST /auth/admin/create-admin", async () => {
    render(<CreateAdminForm />);

    fireEvent.change(screen.getByLabelText(/Username/), {
      target: { value: "new-admin" },
    });
    fireEvent.change(screen.getByLabelText(/Full Name/), {
      target: { value: "New Admin" },
    });
    fireEvent.change(screen.getByLabelText(/Email Address/), {
      target: { value: "new.admin@vhhealth.app" },
    });
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: "SuperSecret1!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Admin" }));

    await screen.findByText("Admin user created successfully!");

    expect(mockedPostJSON).toHaveBeenCalledWith(API_ENDPOINTS.auth.admin.createAdmin, {
      username: "new-admin",
      name: "New Admin",
      email: "new.admin@vhhealth.app",
      password: "SuperSecret1!",
    });
    expect(screen.queryByRole("option", { name: "Super Admin" })).not.toBeInTheDocument();
  });
});
