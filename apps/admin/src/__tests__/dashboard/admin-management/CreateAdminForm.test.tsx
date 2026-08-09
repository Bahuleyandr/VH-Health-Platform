import { fireEvent, render, screen } from "@testing-library/react";

import { CreateAdminForm } from "@/app/(with-auth)/dashboard/admin-management/components/CreateAdminForm";
import { API_ENDPOINTS } from "@/lib/api-config";
import { postJSON } from "@/lib/api";

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

    fireEvent.change(screen.getByLabelText(/Full Name/), {
      target: { value: "New Admin" },
    });
    fireEvent.change(screen.getByLabelText(/Email Address/), {
      target: { value: "new.admin@vhhealth.app" },
    });
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: "SuperSecret1!" },
    });
    fireEvent.change(screen.getByLabelText(/Role/), {
      target: { value: "ADMIN" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Admin" }));

    await screen.findByText("Admin user created successfully!");

    expect(mockedPostJSON).toHaveBeenCalledWith(API_ENDPOINTS.auth.admin.createAdmin, {
      name: "New Admin",
      email: "new.admin@vhhealth.app",
      password: "SuperSecret1!",
      role: "ADMIN",
    });
  });
});
