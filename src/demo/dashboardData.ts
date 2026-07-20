// Client-view dashboard aggregation. Builds chart-ready summaries from
// what was ACTUALLY delivered to each client - webhook inbox payloads for
// webhook clients, and the dropped files (JSON/NDJSON/CSV/Parquet) for
// cloud-storage clients. Nothing here re-runs the engine or peeks at the
// data source: if it didn't arrive through a delivery mechanism, it does
// not appear on the dashboard. That is the point of the demo.

import fs from "fs/promises";
import path from "path";
import { ClientConfig, CloudStorageDeliveryConfig } from "../types/config";
import { ReceivedDelivery } from "./webhookReceiver";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parquet = require("parquetjs-lite");

const MAX_RUNS = 12; // most recent deliveries considered per client

// --- summaries ------------------------------------------------------------

export interface AtlasSummary {
  run_id: string;
  run_at: string;
  post_count: number;
  top_narrative: string;
  sentiment_distribution: { positive: number; neutral: number; negative: number };
  communities: { id: string; size: number; sentiment: number; narrative: string | null }[];
  platform_totals: Record<string, number>;
  language_distribution: Record<string, number>;
  bridge_count: number;
  amplifier_count: number;
}

export interface PipelineSummary {
  run_id: string;
  run_at: string;
  record_count: number;
  by_platform: Record<string, number>;
  by_media_type: Record<string, number>;
  total_engagement: number;
}

export interface ReputationSummary {
  run_id: string;
  run_at: string;
  brand: string;
  brand_score: number;
  score_delta: number;
  article_count: number;
  components: { sentiment: number; coverage: number; relevance: number; age: number };
  top_articles: { url: string; source: string; published_at: string; article_score: number }[];
}

export interface DashboardData {
  client_id: string;
  client_name: string;
  feed_type: string;
  mechanism: string;
  runs_received: number;
  last_run_at: string | null;
  atlas?: { latest: AtlasSummary; history: { run_at: string; post_count: number; positive: number }[] };
  pipeline?: { latest: PipelineSummary; history: { run_at: string; record_count: number }[] };
  reputation?: { latest: ReputationSummary; history: { run_at: string; brand_score: number }[] };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function summarizeAtlas(p: any): AtlasSummary {
  const platformTotals: Record<string, number> = {};
  for (const c of p.communities ?? []) {
    for (const [platform, count] of Object.entries(c.platform_breakdown ?? {})) {
      platformTotals[platform] = (platformTotals[platform] ?? 0) + Number(count);
    }
  }
  return {
    run_id: p.run_id,
    run_at: p.run_at,
    post_count: p.post_count ?? 0,
    top_narrative: p.top_narrative ?? "",
    sentiment_distribution: p.sentiment_distribution ?? { positive: 0, neutral: 1, negative: 0 },
    communities: (p.communities ?? []).map((c: any) => ({
      id: c.id,
      size: c.size,
      sentiment: c.sentiment,
      narrative: c.narrative ?? null,
    })),
    platform_totals: platformTotals,
    language_distribution: p.language_distribution ?? {},
    bridge_count: (p.bridge_nodes ?? []).length,
    amplifier_count: (p.amplifiers ?? []).length,
  };
}

// Pipeline rows arrive either nested (JSON/NDJSON) or flattened with
// dot-delimited keys (CSV/Parquet, per the §4.2 format table) - read both.
function field(row: any, dotted: string): unknown {
  if (dotted in row) return row[dotted];
  return dotted.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), row);
}

function summarizePipeline(runId: string, runAt: string, rows: any[]): PipelineSummary {
  const byPlatform: Record<string, number> = {};
  const byMediaType: Record<string, number> = {};
  let engagement = 0;
  for (const row of rows) {
    const platform = String(field(row, "platform") ?? "unknown");
    const media = String(field(row, "media_type") ?? "unknown");
    byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
    byMediaType[media] = (byMediaType[media] ?? 0) + 1;
    engagement +=
      Number(field(row, "engagement.likes") ?? 0) +
      Number(field(row, "engagement.comments") ?? 0) +
      Number(field(row, "engagement.shares") ?? 0);
  }
  return { run_id: runId, run_at: runAt, record_count: rows.length, by_platform: byPlatform, by_media_type: byMediaType, total_engagement: engagement };
}

function summarizeReputation(p: any): ReputationSummary {
  let topArticles = p.top_articles ?? [];
  if (typeof topArticles === "string") {
    // CSV flattening serializes arrays as JSON strings (§4.2)
    try {
      topArticles = JSON.parse(topArticles);
    } catch {
      topArticles = [];
    }
  }
  return {
    run_id: p.run_id,
    run_at: p.run_at,
    brand: p.brand,
    brand_score: Number(p.brand_score),
    score_delta: Number(p.score_delta),
    article_count: Number(p.article_count),
    components: {
      sentiment: Number(p.sentiment_score),
      coverage: Number(p.coverage_score),
      relevance: Number(p.relevance_score),
      age: Number(p.age_score),
    },
    top_articles: topArticles,
  };
}

// --- file parsing (cloud storage drops) -------------------------------------

// RFC-4180-ish CSV parser: handles quoted fields containing commas,
// newlines, and doubled quotes (top_articles is a JSON string full of
// both). A naive split(",") corrupts every reputation CSV row.
export function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let fieldBuf = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          fieldBuf += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        fieldBuf += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(fieldBuf);
      fieldBuf = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      row.push(fieldBuf);
      fieldBuf = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      fieldBuf += ch;
    }
  }
  if (fieldBuf !== "" || row.length) {
    row.push(fieldBuf);
    rows.push(row);
  }
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

async function readParquetRows(filePath: string): Promise<any[]> {
  const reader = await parquet.ParquetReader.openFile(filePath);
  try {
    const cursor = reader.getCursor();
    const rows: any[] = [];
    let row;
    while ((row = await cursor.next())) rows.push(row);
    return rows;
  } finally {
    await reader.close();
  }
}

// Parsed-file cache keyed by path+size, so polling the dashboard doesn't
// re-read Parquet files that haven't changed.
const fileCache = new Map<string, { size: number; rows: any[] }>();

async function readDropFile(filePath: string, size: number): Promise<any[]> {
  const cached = fileCache.get(filePath);
  if (cached && cached.size === size) return cached.rows;
  const ext = path.extname(filePath).toLowerCase();
  let rows: any[];
  if (ext === ".parquet") {
    rows = await readParquetRows(filePath);
  } else if (ext === ".csv") {
    rows = parseCsv(await fs.readFile(filePath, "utf8"));
  } else if (ext === ".ndjson") {
    rows = (await fs.readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } else {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    rows = Array.isArray(parsed) ? parsed : [parsed];
  }
  fileCache.set(filePath, { size, rows });
  return rows;
}

async function listDropFiles(dir: string): Promise<{ path: string; mtime: Date; size: number }[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { path: string; mtime: Date; size: number }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listDropFiles(full)));
    } else {
      const stat = await fs.stat(full);
      out.push({ path: full, mtime: stat.mtime, size: stat.size });
    }
  }
  return out;
}

// --- assembly ----------------------------------------------------------------

function dedupeByRunId<T extends { run_id: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(item.run_id, item); // later wins (redelivery)
  return [...seen.values()];
}

export async function buildDashboardData(
  client: ClientConfig,
  deliveries: ReceivedDelivery[],
  dropRoot: string
): Promise<DashboardData> {
  const feed = client.feeds[0];
  const mechanism = feed.delivery.mechanism;

  const atlasRuns: AtlasSummary[] = [];
  const pipelineRuns: PipelineSummary[] = [];
  const reputationRuns: ReputationSummary[] = [];

  if (mechanism === "webhook") {
    const bodies = deliveries
      .map((d) => d.body as any)
      .filter((b) => b && typeof b === "object" && b.client_id === client.client_id);
    for (const body of bodies) {
      if (body.feed_type === "atlas") {
        atlasRuns.push(summarizeAtlas(body));
      } else if (body.feed_type === "composite") {
        const c = body.components ?? {};
        if (c.atlas) atlasRuns.push(summarizeAtlas(c.atlas));
        if (Array.isArray(c.reputation) && c.reputation[0]) reputationRuns.push(summarizeReputation(c.reputation[0]));
        if (Array.isArray(c.pipeline)) pipelineRuns.push(summarizePipeline(body.run_id, body.run_at, c.pipeline));
      } else if (body.feed_type === "reputation") {
        reputationRuns.push(summarizeReputation(body));
      } else if (Array.isArray(body)) {
        // pipeline-over-webhook delivers a bare rows array
        pipelineRuns.push(summarizePipeline("unknown", new Date().toISOString(), body));
      }
    }
  } else if (mechanism === "cloud_storage") {
    const cfg = feed.delivery as CloudStorageDeliveryConfig;
    const dir = path.join(dropRoot, cfg.provider, cfg.bucket, client.client_id, feed.feed_type);
    const files = (await listDropFiles(dir)).sort((a, b) => a.mtime.getTime() - b.mtime.getTime()).slice(-MAX_RUNS);
    for (const file of files) {
      const runId = path.basename(file.path).replace(path.extname(file.path), "");
      const runAt = file.mtime.toISOString();
      try {
        const rows = await readDropFile(file.path, file.size);
        if (feed.feed_type === "pipeline") {
          pipelineRuns.push(summarizePipeline(runId, runAt, rows));
        } else if (feed.feed_type === "reputation") {
          if (rows[0]) reputationRuns.push(summarizeReputation({ run_id: runId, run_at: runAt, ...rows[0] }));
        } else if (feed.feed_type === "atlas") {
          if (rows[0]) atlasRuns.push(summarizeAtlas(rows[0]));
        }
      } catch (err) {
        // A partially-written or unreadable file shouldn't blank the whole
        // dashboard - skip it and let the next poll retry.
        // eslint-disable-next-line no-console
        console.error(`dashboard: failed to parse ${file.path}:`, err);
      }
    }
  }

  const atlas = dedupeByRunId(atlasRuns).slice(-MAX_RUNS);
  const pipeline = dedupeByRunId(pipelineRuns).slice(-MAX_RUNS);
  const reputation = dedupeByRunId(reputationRuns).slice(-MAX_RUNS);

  const allRunAts = [...atlas, ...pipeline, ...reputation].map((r) => r.run_at).sort();
  const runsReceived = Math.max(atlas.length, pipeline.length, reputation.length);

  const data: DashboardData = {
    client_id: client.client_id,
    client_name: client.client_name,
    feed_type: feed.feed_type,
    mechanism,
    runs_received: runsReceived,
    last_run_at: allRunAts[allRunAts.length - 1] ?? null,
  };
  if (atlas.length) {
    data.atlas = {
      latest: atlas[atlas.length - 1],
      history: atlas.map((a) => ({ run_at: a.run_at, post_count: a.post_count, positive: a.sentiment_distribution.positive })),
    };
  }
  if (pipeline.length) {
    data.pipeline = {
      latest: pipeline[pipeline.length - 1],
      history: pipeline.map((p) => ({ run_at: p.run_at, record_count: p.record_count })),
    };
  }
  if (reputation.length) {
    data.reputation = {
      latest: reputation[reputation.length - 1],
      history: reputation.map((r) => ({ run_at: r.run_at, brand_score: r.brand_score })),
    };
  }
  return data;
}
