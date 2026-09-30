export type CsvPreview =
  | {
      status: "available";
      columns: string[];
      sampleRows: string[][];
      rows: number;
    }
  | { status: "unavailable" };

export function parseCsvPreview(text: string): CsvPreview {
  let columns: string[] | null = null;
  const sampleRows: string[][] = [];
  let rows = 0;
  let record: string[] = [];
  let field = "";
  let fields = 0;
  let fieldStarted = false;
  let recordStarted = false;
  let quoted = false;
  let quoteClosed = false;
  let retainRecord = true;

  const finishField = () => {
    if (retainRecord) record.push(field);
    fields += 1;
    field = "";
    fieldStarted = false;
    quoteClosed = false;
  };

  const finishRecord = () => {
    if (columns === null) {
      columns = record;
    } else {
      if (fields !== columns.length) return false;
      if (retainRecord) sampleRows.push(record);
      rows += 1;
    }
    record = [];
    fields = 0;
    recordStarted = false;
    retainRecord = rows < 5;
    return true;
  };

  for (
    let index = text.startsWith("\uFEFF") ? 1 : 0;
    index < text.length;
    index += 1
  ) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          if (retainRecord) field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else if (retainRecord) {
        field += char;
      }
    } else if (char === '"') {
      if (fieldStarted || quoteClosed) return { status: "unavailable" };
      quoted = true;
      fieldStarted = true;
      recordStarted = true;
    } else if (char === ",") {
      finishField();
      recordStarted = true;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishField();
      if (!finishRecord()) return { status: "unavailable" };
    } else {
      if (quoteClosed) return { status: "unavailable" };
      if (retainRecord) field += char;
      fieldStarted = true;
      recordStarted = true;
    }
  }

  if (quoted) return { status: "unavailable" };
  if (recordStarted) {
    finishField();
    if (!finishRecord()) return { status: "unavailable" };
  }
  return { status: "available", columns: columns ?? [], sampleRows, rows };
}
