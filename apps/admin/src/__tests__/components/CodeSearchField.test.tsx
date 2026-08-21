// WP2 — shared diagnosis-code typeahead. Pins the degrade-to-free-text
// contract: search errors and empty catalogues leave the input behaving as
// a plain text field, while a successful search offers pickable suggestions.

import {
  CodeSearchField,
  CodeMultiSearchField,
} from "@/components/terminology/CodeSearchField";
import { searchTerminology } from "@/lib/api/terminology";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/lib/api/terminology", () => ({
  searchTerminology: jest.fn(),
}));

const mockedSearch = searchTerminology as jest.MockedFunction<
  typeof searchTerminology
>;

const CONCEPTS = [
  {
    system_key: "ICD10",
    code: "I21.9",
    display: "Acute myocardial infarction, unspecified",
  },
  { system_key: "ICD10", code: "I21.0", display: "Acute transmural MI" },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("<CodeSearchField />", () => {
  test("renders a plain input and propagates typed text (free-text path)", async () => {
    mockedSearch.mockResolvedValue([]);
    const onChange = jest.fn();
    render(<CodeSearchField label="Ia ICD-10" value="" onChange={onChange} />);
    expect(screen.getByText("Ia ICD-10")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "I");
    expect(onChange).toHaveBeenCalledWith("I");
  });

  test("shows suggestions after a successful search and picks one", async () => {
    mockedSearch.mockResolvedValue(CONCEPTS);
    const onChange = jest.fn();
    const onConceptSelected = jest.fn();

    function Harness() {
      return (
        <CodeSearchField
          label="Ia ICD-10"
          value="myocard"
          onChange={onChange}
          onConceptSelected={onConceptSelected}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "i");

    await waitFor(() =>
      expect(
        screen.getByText("Acute myocardial infarction, unspecified"),
      ).toBeInTheDocument(),
    );
    expect(mockedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ system: "ICD10" }),
    );

    await userEvent.click(screen.getByText("I21.9"));
    expect(onChange).toHaveBeenLastCalledWith("I21.9");
    expect(onConceptSelected).toHaveBeenCalledWith(
      expect.objectContaining({ code: "I21.9" }),
    );
  });

  test("degrades silently when the search endpoint errors", async () => {
    mockedSearch.mockRejectedValue(new Error("proxy prefix not registered"));
    const onChange = jest.fn();
    render(<CodeSearchField value="ab" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "c");
    // The search fires and fails; no dropdown, no crash, typing still works.
    await waitFor(() => expect(mockedSearch).toHaveBeenCalled());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  test("queries shorter than 2 characters never hit the API", async () => {
    render(<CodeSearchField value="" onChange={jest.fn()} />);
    await userEvent.type(screen.getByRole("textbox"), "a");
    await new Promise((r) => setTimeout(r, 400));
    expect(mockedSearch).not.toHaveBeenCalled();
  });
});

describe("<CodeMultiSearchField />", () => {
  test("Enter commits free text as a chip even with no catalogue", async () => {
    mockedSearch.mockResolvedValue([]);
    const onChange = jest.fn();
    render(<CodeMultiSearchField values={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "I21.9{Enter}");
    expect(onChange).toHaveBeenCalledWith(["I21.9"]);
  });

  test("picking a suggestion adds its code as a chip", async () => {
    mockedSearch.mockResolvedValue(CONCEPTS);
    const onChange = jest.fn();
    render(<CodeMultiSearchField values={[]} onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox"), "myocard");
    await waitFor(() => expect(screen.getByText("I21.0")).toBeInTheDocument());
    await userEvent.click(screen.getByText("I21.0"));
    expect(onChange).toHaveBeenCalledWith(["I21.0"]);
  });

  test("renders existing chips and removes one", async () => {
    mockedSearch.mockResolvedValue([]);
    const onChange = jest.fn();
    render(
      <CodeMultiSearchField values={["I21.9", "E11.9"]} onChange={onChange} />,
    );
    expect(screen.getByText("I21.9")).toBeInTheDocument();
    expect(screen.getByText("E11.9")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Remove I21.9"));
    expect(onChange).toHaveBeenCalledWith(["E11.9"]);
  });

  test("does not add case-insensitive duplicates", async () => {
    mockedSearch.mockResolvedValue([]);
    const onChange = jest.fn();
    render(<CodeMultiSearchField values={["I21.9"]} onChange={onChange} />);
    await userEvent.type(screen.getByRole("textbox"), "i21.9{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });
});
