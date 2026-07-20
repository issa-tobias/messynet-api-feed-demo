// Formatter component of the Feed Engine (PRD §2.3, §4.2 "Supported
// formats"). Serializes rows to JSON / NDJSON / CSV / Parquet.
//
// CSV and Parquet operate on flattened rows: nested fields become
// dot-delimited keys and arrays are JSON-stringified, per the explicit
// note in PRD §4.2's format table ("Flattened schema. Nested fields
// dot-delimited. Arrays serialized as JSON strings.").

import os from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { DeliveryFormat } from "../types/config";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parquet = require("parquetjs-lite");

export type FlatRow = Record<string, string | number | boolean | null>;

export function flatten(obj: Record<string, unknown>, prefix = ""): FlatRow {
  const out: FlatRow = {};
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      out[flatKey] = JSON.stringify(value);
    } else if (value !== null && typeof value === "object") {
      Object.assign(out, flatten(value as Record<string, unknown>, flatKey));
    } else {
      out[flatKey] = value as string | number | boolean | null;
    }
  }
  return out;
}

export function formatJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function formatNdjson(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

function csvEscape(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const flatRows = rows.map((r) => flatten(r));
  const columns = Array.from(new Set(flatRows.flatMap((r) => Object.keys(r)))).sort();
  const header = columns.join(",");
  const lines = flatRows.map((row) => columns.map((c) => csvEscape(row[c] ?? null)).join(","));
  return [header, ...lines].join("\n");
}

function inferParquetType(rows: FlatRow[], column: string): "UTF8" | "DOUBLE" | "BOOLEAN" {
  for (const row of rows) {
    const v = row[column];
    if (v === null || v === undefined) continue;
    if (typeof v === "number") return "DOUBLE";
    if (typeof v === "boolean") return "BOOLEAN";
    return "UTF8";
  }
  return "UTF8";
}

// Parquet support is genuinely new for this build (PRD open items C8/J2:
// "is a Parquet serializer already in place, or is this a new build?").
// This answers that question for the *new* Feed Engine: yes, a working
// pure-JS serializer (parquetjs-lite) is wired in. Whether it ships in
// v1 vs v1.1 remains the CTO's call.
export async function formatParquet(rows: Record<string, unknown>[]): Promise<Buffer> {
  const flatRows = rows.map((r) => flatten(r));
  const columns = Array.from(new Set(flatRows.flatMap((r) => Object.keys(r)))).sort();

  const schemaFields: Record<string, { type: string; optional: boolean }> = {};
  for (const col of columns) {
    schemaFields[col] = { type: inferParquetType(flatRows, col), optional: true };
  }
  const schema = new parquet.ParquetSchema(schemaFields);

  const tmpPath = path.join(os.tmpdir(), `messynet-feed-${Date.now()}-${Math.random().toString(36).slice(2)}.parquet`);
  const writer = await parquet.ParquetWriter.openFile(schema, tmpPath);
  for (const row of flatRows) {
    await writer.appendRow(row);
  }
  await writer.close();

  const buffer = await fsp.readFile(tmpPath);
  await fsp.unlink(tmpPath);
  return buffer;
}

export async function formatRows(
  rows: Record<string, unknown>[],
  format: DeliveryFormat
): Promise<{ body: string | Buffer; extension: string }> {
  switch (format) {
    case "json":
      return { body: formatJson(rows), extension: "json" };
    case "ndjson":
      return { body: formatNdjson(rows), extension: "ndjson" };
    case "csv":
      return { body: formatCsv(rows), extension: "csv" };
    case "parquet":
      return { body: await formatParquet(rows), extension: "parquet" };
  }
}

// For single-object payloads (e.g. Atlas, which is one JSON object per
// run rather than an array of rows). JSON is the only format that
// preserves the nested structure without lossy flattening; other formats
// still work by treating the object as a single-row table.
export async function formatObject(
  payload: Record<string, unknown>,
  format: DeliveryFormat
): Promise<{ body: string | Buffer; extension: string }> {
  if (format === "json") {
    return { body: formatJson(payload), extension: "json" };
  }
  return formatRows([payload], format);
}
