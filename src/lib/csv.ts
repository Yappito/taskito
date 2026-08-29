/**
 * Minimal RFC 4180 CSV helpers.
 *
 * - `parseCsvRecords` / `parseCsv`: tolerant RFC 4180 parser that handles
 *   quoted fields, escaped double quotes, embedded newlines (LF, CRLF, CR),
 *   and a leading UTF-8 BOM.
 * - `escapeCsvField` / `stringifyCsvRow`: RFC 4180 writer that quotes fields
 *   containing commas, double quotes, or newlines (doubling inner quotes) and
 *   joins records with CRLF.
 */

/** A single parsed CSV record with the 1-indexed source line it starts on. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/** Removes a leading UTF-8 BOM if present. */
export function stripCsvBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/**
 * Parses CSV text into records, tracking the physical start line of each
 * record (the header row of a CSV starts at line 1).
 *
 * Throws an `Error` mentioning the offending line when a quoted field is
 * never closed.
 */
export function parseCsvRecords(rawInput: string): CsvRecord[] {
  const input = stripCsvBom(rawInput);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let recordLine = 1;
  let currentLine = 1;
  let sawContent = false;

  const pushField = () => {
    cells.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const pushRecord = () => {
    pushField();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    sawContent = true;

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      field += char;
      if (char === "\n") {
        currentLine += 1;
      } else if (char === "\r" && input[index + 1] !== "\n") {
        currentLine += 1;
      }
      continue;
    }

    if (char === ",") {
      pushField();
      continue;
    }

    if (char === '"') {
      if (field === "" && !fieldWasQuoted) {
        inQuotes = true;
        fieldWasQuoted = true;
      } else {
        // Tolerate stray quotes inside unquoted fields.
        field += char;
      }
      continue;
    }

    if (char === "\r" || char === "\n") {
      pushRecord();
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      currentLine += 1;
      recordLine = currentLine;
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error(`Unterminated quoted field ending near line ${currentLine}`);
  }

  if (sawContent && (field !== "" || cells.length > 0)) {
    pushRecord();
  }

  return records;
}

/** Parses CSV text into arrays of cells (BOM stripped, no record metadata). */
export function parseCsv(input: string): string[][] {
  return parseCsvRecords(input).map((record) => record.cells);
}

/** True when the field must be quoted to stay RFC 4180 compliant. */
function needsQuotes(value: string) {
  return /[",\r\n]/.test(value);
}

/** Escapes a single CSV field, quoting and doubling inner quotes when needed. */
export function escapeCsvField(value: string): string {
  return needsQuotes(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Renders one CSV record as a CRLF-terminated, RFC 4180 compliant line. */
export function stringifyCsvRow(cells: string[]): string {
  return `${cells.map(escapeCsvField).join(",")}\r\n`;
}
