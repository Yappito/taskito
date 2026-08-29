import { describe, expect, it } from "vitest";

import {
  escapeCsvField,
  parseCsv,
  parseCsvRecords,
  stringifyCsvRow,
  stripCsvBom,
} from "@/lib/csv";

describe("csv parser", () => {
  it("parses simple rows with a trailing newline", () => {
    expect(parseCsv("a,b,c\r\n1,2,3\r\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("parses input without a trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps quoted fields with commas, doubled quotes, and spaces", () => {
    expect(parseCsv('"a,b","he said ""hi"""," leading"')).toEqual([
      ["a,b", 'he said "hi"', " leading"],
    ]);
  });

  it("preserves embedded LF newlines inside quoted fields", () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([["line1\nline2", "x"]]);
  });

  it("preserves embedded CRLF newlines inside quoted fields", () => {
    expect(parseCsv('"row A\r\nCRLF continues",keep\r\nnext,record\r\n')).toEqual([
      ["row A\r\nCRLF continues", "keep"],
      ["next", "record"],
    ]);
  });

  it("supports LF-only line endings between records", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("strips a UTF-8 BOM before the first header cell", () => {
    const input = "\uFEFFTitle,Status\r\nT1,Done\r\n";
    expect(parseCsv(input)).toEqual([
      ["Title", "Status"],
      ["T1", "Done"],
    ]);
    expect(stripCsvBom("x")[0]).toBe("x");
  });

  it("emits empty fields for consecutive commas", () => {
    expect(parseCsv("a,,c\r\n")).toEqual([["a", "", "c"]]);
  });

  it("tracks the physical start line of each record", () => {
    const records = parseCsvRecords('h1,h2\r\n"a\r\nb",x\r\nplain,y\r\n');
    expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
    expect(records[1].cells).toEqual(["a\r\nb", "x"]);
  });

  it("emits a one-empty-cell record for blank mid-file lines (import skips them)", () => {
    const records = parseCsvRecords("a,b\r\n\r\n1,2\r\n");
    expect(records).toHaveLength(3);
    expect(records[0].cells).toEqual(["a", "b"]);
    expect(records[1].cells).toEqual([""]);
    expect(records[1].line).toBe(2);
    expect(records[2].cells).toEqual(["1", "2"]);
    expect(records[2].line).toBe(3);
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseCsv('"open,forever')).toThrow(/Unterminated quoted field/);
  });

  it("round-trips fields through the writer", () => {
    const cells = ["KEY-1", "Title, with comma", 'say "hi"', "body\nline2\r\nline3", ""];
    const rendered = stringifyCsvRow(cells);
    expect(rendered.endsWith("\r\n")).toBe(true);
    expect(parseCsv(rendered)[0]).toEqual(cells);
  });
});

describe("csv writer", () => {
  it("leaves plain fields unquoted", () => {
    expect(escapeCsvField("plain")).toBe("plain");
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField("a\nb")).toBe('"a\nb"');
    expect(escapeCsvField("a\rb")).toBe('"a\rb"');
  });

  it("renders rows as CRLF-terminated RFC 4180 lines", () => {
    expect(stringifyCsvRow(["a", "b,c", 'd"e'])).toBe('a,"b,c","d""e"\r\n');
  });
});
