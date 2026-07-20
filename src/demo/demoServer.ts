// Demo Console: a single process that runs the real Feed Engine + the real
// REST API (Delta Polling, Run Log) alongside demo-only endpoints (trigger
// a run on demand, view what a client's webhook inbox received, browse
// cloud storage drops) and serves the static dashboard in public/.
//
// This is a demonstration tool, not part of the production service in
// src/index.ts - it exists to make PRD §2.3's architecture and §4's
// delivery mechanisms visible and clickable, backed by real code paths
// rather than a mockup.

process.env.ALLOW_INSECURE_WEBHOOKS_FOR_DEMO = "true";

import fs from "fs/promises";
import path from "path";
import express, { Request, Response } from "express";
import { MockDataSource } from "../data/mockDataSource";
import { Extractor } from "../engine/extractor";
import { FeedEngine } from "../engine/feedEngine";
import { runLogger } from "../engine/runLogger";
import { deadLetterQueue, redeliverFromDeadLetter } from "../engine/deliveryAgent";
import { createServer, jsonErrorHandler, jsonNotFound } from "../api/server";
import { SAMPLE_CLIENTS, DEMO_API_KEYS } from "../config/sampleClients";
import { InMemoryWebhookSecretProvider } from "../config/webhookSecrets";
import { createWebhookReceiver } from "./webhookReceiver";
import { buildDashboardData } from "./dashboardData";
import { WebhookDeliveryConfig } from "../types/config";

// PORT is what hosting platforms (Render, Cloud Run) inject; DEMO_PORT
// keeps the local override; 4200 is the local default.
const PORT = Number(process.env.PORT) || Number(process.env.DEMO_PORT) || 4200;
const INBOX_PATH = "/demo/messynet-feed";
const DROP_ROOT = path.join(process.cwd(), ".data-drops");
// Compressed version of the §7.2 exponential backoff (5 min/30 min/2 h/6 h
// becomes 3 s/6 s/10 s/15 s) - slow enough to watch attempts count up in
// the run log, fast enough that a dead-letter takes ~35 s, not ~9 h.
const DEMO_RETRY_SCHEDULE = [0, 3_000, 6_000, 10_000, 15_000];

const dataSource = new MockDataSource();
const extractor = new Extractor(dataSource);
const secrets = new InMemoryWebhookSecretProvider();
const engine = new FeedEngine(dataSource, extractor, secrets);

// Demo controls, toggled from the UI: `outage` makes the inbox return 503
// (driving the real retry/DLQ path); `autoTimer` is the auto-deliver mode
// that fires scheduled runs without anyone clicking.
let outageEnabled = false;
let autoTimer: NodeJS.Timeout | null = null;
let autoIntervalMs = 12_000;
let autoIndex = 0;

// Point every webhook-delivered sample feed at this process's own inbox,
// so triggering a run in the UI produces a real HTTP delivery you can
// inspect, not a simulated one.
const secretsByClientId: Record<string, string> = {};
for (const client of SAMPLE_CLIENTS) {
  for (const feed of client.feeds) {
    if (feed.delivery.mechanism === "webhook") {
      feed.delivery = {
        ...(feed.delivery as WebhookDeliveryConfig),
        endpoint: `http://localhost:${PORT}${INBOX_PATH}`,
      };
      secretsByClientId[client.client_id] = secrets.getSecret(client.client_id);
    }
  }
}

const { app: receiverApp, deliveries } = createWebhookReceiver(secretsByClientId, {
  shouldReject: () => outageEnabled,
});

const app = express();

// Mount the receiver ("the client's system") at the exact inbox path only
// - not the broader /demo prefix. receiverApp carries its own catch-all
// body-parser; mounting it at /demo would run that parser for every
// sibling /demo/* route too (e.g. /demo/trigger), and body-parser's
// double-parse guard would then silently skip the JSON parsing those
// routes need, leaving req.body as unparsed raw text. Scoping the mount
// to the one path it owns keeps it from touching unrelated requests.
app.use(INBOX_PATH, receiverApp);
app.use(createServer(SAMPLE_CLIENTS, dataSource, runLogger));

app.get("/demo/clients", (_req: Request, res: Response) => {
  res.json(
    SAMPLE_CLIENTS.map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      sla_tier: c.sla_tier,
      api_key: DEMO_API_KEYS[c.client_id as keyof typeof DEMO_API_KEYS],
      scopes: c.auth.scopes,
      feeds: c.feeds.map((f, index) => ({
        index,
        feed_type: f.feed_type,
        schema_version: f.schema_version,
        cadence: f.cadence,
        delivery: f.delivery,
        composite_components: f.composite_components ?? null,
      })),
    }))
  );
});

app.post("/demo/trigger", express.json(), async (req: Request, res: Response) => {
  const { client_id, feed_index } = req.body as { client_id?: string; feed_index?: number };
  const client = SAMPLE_CLIENTS.find((c) => c.client_id === client_id);
  if (!client) {
    res.status(404).json({ error: "unknown client_id" });
    return;
  }
  const feed = client.feeds[feed_index ?? -1];
  if (!feed) {
    res.status(404).json({ error: "unknown feed_index" });
    return;
  }
  try {
    // Respond as soon as the run exists rather than when delivery reaches
    // a terminal state - with the outage toggle on, the retry cycle runs
    // ~35 s and the UI polls GET /demo/run/:id to watch it live.
    const runId = await new Promise<string>((resolve, reject) => {
      engine
        .runFeed(client, feed, { retryScheduleMsOverride: DEMO_RETRY_SCHEDULE, onRunCreated: resolve })
        .then(resolve)
        .catch(reject);
    });
    res.json({ run_id: runId, run_log: runLogger.get(runId) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/demo/run/:runId", (req: Request, res: Response) => {
  const entry = runLogger.get(req.params.runId);
  if (!entry) {
    res.status(404).json({ error: "unknown run_id" });
    return;
  }
  res.json(entry);
});

// --- Auto-deliver mode: the push story telling itself --------------------
// Fires a real scheduled run for each client in rotation, so deliveries
// arrive unprompted while you watch - the demo equivalent of the cron
// cadence the production Scheduler runs (PRD §2.3).
function autoTick(): void {
  const client = SAMPLE_CLIENTS[autoIndex % SAMPLE_CLIENTS.length];
  autoIndex += 1;
  engine.runFeed(client, client.feeds[0], { retryScheduleMsOverride: DEMO_RETRY_SCHEDULE }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`auto-deliver run failed for ${client.client_id}:`, err);
  });
}

app.get("/demo/scheduler", (_req: Request, res: Response) => {
  res.json({ enabled: autoTimer !== null, interval_seconds: autoIntervalMs / 1000 });
});

app.post("/demo/scheduler", express.json(), (req: Request, res: Response) => {
  const { enabled, interval_seconds } = req.body as { enabled?: boolean; interval_seconds?: number };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "bad_request", message: "'enabled' (boolean) is required" });
    return;
  }
  if (interval_seconds !== undefined) {
    const s = Number(interval_seconds);
    if (!Number.isFinite(s) || s < 3 || s > 300) {
      res.status(400).json({ error: "bad_request", message: "'interval_seconds' must be between 3 and 300" });
      return;
    }
    autoIntervalMs = s * 1000;
  }
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (enabled) {
    autoTick(); // first delivery lands immediately, not one interval later
    autoTimer = setInterval(autoTick, autoIntervalMs);
  }
  res.json({ enabled: autoTimer !== null, interval_seconds: autoIntervalMs / 1000 });
});

// --- Outage simulation: drives the §7.2 retry/backoff/DLQ path -----------
app.get("/demo/outage", (_req: Request, res: Response) => {
  res.json({ enabled: outageEnabled });
});

app.post("/demo/outage", express.json(), (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "bad_request", message: "'enabled' (boolean) is required" });
    return;
  }
  outageEnabled = enabled;
  res.json({ enabled: outageEnabled });
});

app.get("/demo/dlq", (_req: Request, res: Response) => {
  // Strip the stored payloads - the UI needs the failure metadata, not
  // megabytes of undelivered JSON.
  res.json(deadLetterQueue.list().map(({ redelivery: _r, ...meta }) => meta));
});

app.post("/demo/redeliver", express.json(), async (req: Request, res: Response) => {
  const { run_id } = req.body as { run_id?: string };
  if (!run_id) {
    res.status(400).json({ error: "bad_request", message: "'run_id' is required" });
    return;
  }
  const result = await redeliverFromDeadLetter(run_id, DEMO_RETRY_SCHEDULE);
  const status = result.ok ? 200 : 409;
  res.status(status).json({ ...result, run_log: runLogger.get(run_id) ?? null });
});

// --- Client-view dashboard: aggregates of what actually arrived ----------
app.get("/demo/dashboard/:clientId", async (req: Request, res: Response) => {
  const client = SAMPLE_CLIENTS.find((c) => c.client_id === req.params.clientId);
  if (!client) {
    res.status(404).json({ error: "unknown client_id" });
    return;
  }
  try {
    res.json(await buildDashboardData(client, deliveries, DROP_ROOT));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/demo/inbox", (_req: Request, res: Response) => {
  res.json(deliveries.slice(-25).reverse());
});

app.get("/demo/runs", (_req: Request, res: Response) => {
  const all = SAMPLE_CLIENTS.flatMap((c) => runLogger.query({ clientId: c.client_id }));
  all.sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime());
  res.json(all.slice(0, 50));
});

async function walkDrops(dir: string, base: string): Promise<{ path: string; size: number; mtime: string }[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: { path: string; size: number; mtime: string }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDrops(full, base)));
    } else {
      const stat = await fs.stat(full);
      results.push({ path: path.relative(base, full), size: stat.size, mtime: stat.mtime.toISOString() });
    }
  }
  return results;
}

app.get("/demo/drops", async (_req: Request, res: Response) => {
  const files = await walkDrops(DROP_ROOT, DROP_ROOT);
  files.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  res.json(files);
});

app.get("/demo/drops/preview", async (req: Request, res: Response) => {
  const requested = String(req.query.path ?? "");
  const resolved = path.resolve(DROP_ROOT, requested);
  if (!resolved.startsWith(DROP_ROOT + path.sep)) {
    res.status(400).json({ error: "invalid path" });
    return;
  }
  try {
    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".parquet") {
      const stat = await fs.stat(resolved);
      res.json({ binary: true, format: "parquet", size: stat.size, note: "Columnar binary format - open with a Parquet reader to inspect rows." });
      return;
    }
    const content = await fs.readFile(resolved, "utf8");
    res.json({ binary: false, format: ext.slice(1) || "text", content: content.slice(0, 5000) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.use(express.static(path.join(__dirname, "../../public")));

// After all routes and static assets: JSON 404 + JSON error responses
// (no HTML error pages, no stack traces with server file paths).
app.use(jsonNotFound);
app.use(jsonErrorHandler);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`MessyNet API Feed - Demo Console: http://localhost:${PORT}`);
});
