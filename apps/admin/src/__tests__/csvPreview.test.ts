import { parseCsvPreview } from "@/lib/csvPreview";

describe("parseCsvPreview", () => {
  it("preserves quoted commas and doubled quotes", () => {
    expect(
      parseCsvPreview('Name,Note\r\n"Doe, Jane","Said ""hello"""\r\n'),
    ).toEqual({
      status: "available",
      columns: ["Name", "Note"],
      sampleRows: [["Doe, Jane", 'Said "hello"']],
      rows: 1,
    });
  });

  it.each(["\r\n", "\n", "\r"])(
    "preserves quoted line breaks %j without counting extra records",
    (newline) => {
      expect(
        parseCsvPreview(`Name,Note\r\nJane,"first${newline}second"\r\n`),
      ).toEqual({
        status: "available",
        columns: ["Name", "Note"],
        sampleRows: [["Jane", `first${newline}second`]],
        rows: 1,
      });
    },
  );

  it.each(["\r\n", "\n", "\r"])(
    "accepts record separator %j without an extra trailing row",
    (newline) => {
      expect(parseCsvPreview(`Name${newline}Jane${newline}`)).toEqual({
        status: "available",
        columns: ["Name"],
        sampleRows: [["Jane"]],
        rows: 1,
      });
    },
  );

  it.each(["", "\uFEFF"])("handles an empty document %j", (csv) => {
    expect(parseCsvPreview(csv)).toEqual({
      status: "available",
      columns: [],
      sampleRows: [],
      rows: 0,
    });
  });

  it.each(["Name,Note", "Name,Note\r\n", "\uFEFFName,Note\n"])(
    "handles a header-only document %j",
    (csv) => {
      expect(parseCsvPreview(csv)).toEqual({
        status: "available",
        columns: ["Name", "Note"],
        sampleRows: [],
        rows: 0,
      });
    },
  );

  it("removes only the initial BOM and preserves empty cells and whitespace", () => {
    expect(parseCsvPreview('\uFEFFName,Note,End\r\n Jane ,"\uFEFF",')).toEqual({
      status: "available",
      columns: ["Name", "Note", "End"],
      sampleRows: [[" Jane ", "\uFEFF", ""]],
      rows: 1,
    });
  });

  it("retains duplicate and empty headers by column position", () => {
    expect(parseCsvPreview('Name,Name,\r\nJane,Doctor,""')).toEqual({
      status: "available",
      columns: ["Name", "Name", ""],
      sampleRows: [["Jane", "Doctor", ""]],
      rows: 1,
    });
  });

  it("parses quoted header delimiters and escapes with the same rules", () => {
    expect(parseCsvPreview('"Last, First","A ""quote"""\nJane,Note')).toEqual({
      status: "available",
      columns: ["Last, First", 'A "quote"'],
      sampleRows: [["Jane", "Note"]],
      rows: 1,
    });
  });

  it("does not change formula-neutralized cell contents", () => {
    expect(parseCsvPreview("Value\n'=SUM(A1:A2)\n'@command")).toEqual({
      status: "available",
      columns: ["Value"],
      sampleRows: [["'=SUM(A1:A2)"], ["'@command"]],
      rows: 2,
    });
  });

  it("preserves Unicode values across the five supported locales", () => {
    expect(
      parseCsvPreview("en,hi,ta,te,ml\nEnglish,हिन्दी,தமிழ்,తెలుగు,മലയാളം"),
    ).toEqual({
      status: "available",
      columns: ["en", "hi", "ta", "te", "ml"],
      sampleRows: [["English", "हिन्दी", "தமிழ்", "తెలుగు", "മലയാളം"]],
      rows: 1,
    });
  });

  it("retains explicitly quoted empty headers and records", () => {
    expect(parseCsvPreview('""\n""\n')).toEqual({
      status: "available",
      columns: [""],
      sampleRows: [[""]],
      rows: 1,
    });
  });

  it("counts every logical record but retains only the first five", () => {
    const csv = `Name,Note\n${Array.from(
      { length: 1000 },
      (_, index) => `${index},"first\nsecond"`,
    ).join("\n")}\n`;
    expect(parseCsvPreview(csv)).toEqual({
      status: "available",
      columns: ["Name", "Note"],
      sampleRows: Array.from({ length: 5 }, (_, index) => [
        String(index),
        "first\nsecond",
      ]),
      rows: 1000,
    });
  });

  it("counts an explicit blank record instead of silently dropping it", () => {
    expect(parseCsvPreview("Name\n\nJane\n")).toEqual({
      status: "available",
      columns: ["Name"],
      sampleRows: [[""], ["Jane"]],
      rows: 2,
    });
  });

  it.each([
    'Name\n"unfinished',
    'Name\nJa"ne',
    'Name\n"Jane"extra',
    'Name\n"Jane" ',
    "Name,Note\nJane",
    "Name\nJane,extra",
    "Name,Note\n\n",
  ])("makes the whole malformed preview unavailable: %j", (csv) => {
    expect(parseCsvPreview(csv)).toEqual({ status: "unavailable" });
  });

  it.each(['"unfinished', "Six,extra", 'Si"x', '"Six"extra', '"Six" '])(
    "validates a late malformed record %j before publishing a count",
    (lastRecord) => {
      expect(
        parseCsvPreview(`Name\nOne\nTwo\nThree\nFour\nFive\n${lastRecord}`),
      ).toEqual({ status: "unavailable" });
    },
  );
});
