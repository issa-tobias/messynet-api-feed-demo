// End-to-end demo: exercises every component against the mock data layer
// without needing real MongoDB/Atlas/MessyRep/S3 credentials.
//
//   npm run demo
//
// What it proves:
//   1. Webhook delivery with HMAC signing, verified by a receiver that
//      mimics the PRD §6.2 client-side verification code.
//   2. Cloud Storage Drop with the exact naming convention from §4.2,
//      including a real Parquet round-trip (write + read back).
//   3. CSV formatting for a Reputation Feed drop.
//   4. Composite Feed bundling two component feed types into one payload.
//   5. The Delta Polling and Run Log REST endpoints, including auth,
//      scope, and validation failure paths.

process.env.ALLOW_INSECURE_WEBHOOKS_FOR_DEMO = "true";

import fs from "fs/promises";
import path from "path";
import { MockDataSource } from "../data/mockDataSource";
import { Extractor } from "../engine/extractor";
import { FeedEngine } from "../engine/feedEngine";
import { runLogger } from "../engine/runLogger";
import { createServer } from "../api/server";
import { SAMPLE_CLIENTS, DEMO_API_KEYS } from "../config/sampleClients";
import { InMemoryWebhookSecretProvider } from "../config/webhookSecrets";
import { createWebhookReceiver } from "./webhookReceiver";
import { WebhookDeliveryConfig } from "../types/config";

const WEBHOOK_RECEIVER_PORT = 4101;
const API_PORT = 4100;

function section(title: string): void {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

async function main(): Promise<void> {
  const dataSource = new MockDataSource();
  const extractor = new Extractor(dataSource);
  const secrets = new InMemoryWebhookSecretProvider();
  const engine = new FeedEngine(dataSource, extractor, secrets);

  // --- Wire up demo receiver + point webhook-delivered clients at it -----
  const { app: receiverApp, deliveries } = createWebhookReceiver({
    "solstice-sg": secrets.getSecret("solstice-sg"),
    "orbit-whitelabel": secrets.getSecret("orbit-whitelabel"),
  });
  await new Promise<void>((resolve) => receiverApp.listen(WEBHOOK_RECEIVER_PORT, resolve));

  // Demo-only: skip the real multi-hour exponential backoff so a failed
  // delivery surfaces immediately instead of hanging the script.
  const FAST_RETRY_SCHEDULE = [0, 0, 0, 0, 0];

  const solstice = SAMPLE_CLIENTS.find((c) => c.client_id === "solstice-sg")!;
  solstice.feeds[0].delivery = {
    ...(solstice.feeds[0].delivery as WebhookDeliveryConfig),
    endpoint: `http://localhost:${WEBHOOK_RECEIVER_PORT}`,
  };

  const orbit = SAMPLE_CLIENTS.find((c) => c.client_id === "orbit-whitelabel")!;
  orbit.feeds[0].delivery = {
    ...(orbit.feeds[0].delivery as WebhookDeliveryConfig),
    endpoint: `http://localhost:${WEBHOOK_RECEIVER_PORT}`,
  };

  // --- 1. Atlas Intelligence Feed -> Webhook + HMAC ----------------------
  section("1. Atlas Intelligence Feed -> Webhook POST (HMAC-signed)");
  const atlasRunId = await engine.runFeed(solstice, solstice.feeds[0], { retryScheduleMsOverride: FAST_RETRY_SCHEDULE });
  await new Promise((r) => setTimeout(r, 200));
  console.log("Run log entry:", runLogger.get(atlasRunId));
  const delivered = deliveries[deliveries.length - 1];
  console.log("Signature valid:", delivered.signatureValid);
  console.log("Delivered headers:", {
    "x-messynet-feed": delivered.headers["x-messynet-feed"],
    "x-messynet-run-id": delivered.headers["x-messynet-run-id"],
  });
  const atlasBody = delivered.body as { post_count: number; communities: unknown[]; top_narrative: string };
  console.log("Payload summary:", {
    post_count: atlasBody.post_count,
    communities: atlasBody.communities.length,
    top_narrative: atlasBody.top_narrative,
  });

  // --- 2. Pipeline Feed -> Cloud Storage Drop (Parquet) ------------------
  section("2. Pipeline Feed -> Cloud Storage Drop (Parquet round-trip)");
  const northwire = SAMPLE_CLIENTS.find((c) => c.client_id === "northwire-apac")!;
  const pipelineRunId = await engine.runFeed(northwire, northwire.feeds[0], { retryScheduleMsOverride: FAST_RETRY_SCHEDULE });
  const pipelineLog = runLogger.get(pipelineRunId)!;
  console.log("Run log entry:", pipelineLog);

  const dropRoot = path.join(process.cwd(), ".data-drops", "gcs", "northwire-data", "northwire-apac", "pipeline");
  const dateDir = (await fs.readdir(dropRoot))[0];
  const parquetPath = path.join(dropRoot, dateDir, `${pipelineRunId}.parquet`);
  const stat = await fs.stat(parquetPath);
  console.log("Wrote file:", path.relative(process.cwd(), parquetPath), `(${stat.size} bytes)`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const parquet = require("parquetjs-lite");
  const reader = await parquet.ParquetReader.openFile(parquetPath);
  const cursor = reader.getCursor();
  const firstRow = await cursor.next();
  console.log("First row read back from Parquet file:", firstRow);
  await reader.close();

  // --- 3. Reputation Feed -> Cloud Storage Drop (CSV) --------------------
  section("3. Reputation Feed -> Cloud Storage Drop (CSV)");
  const acme = SAMPLE_CLIENTS.find((c) => c.client_id === "acme-brand-sg")!;
  const reputationRunId = await engine.runFeed(acme, acme.feeds[0], { retryScheduleMsOverride: FAST_RETRY_SCHEDULE });
  console.log("Run log entry:", runLogger.get(reputationRunId));
  const csvPath = path.join(
    process.cwd(),
    ".data-drops",
    "s3",
    "acme-messynet-bi",
    "acme-brand-sg",
    "reputation",
    (await fs.readdir(path.join(process.cwd(), ".data-drops", "s3", "acme-messynet-bi", "acme-brand-sg", "reputation")))[0],
    `${reputationRunId}.csv`
  );
  const csvContent = await fs.readFile(csvPath, "utf8");
  console.log("CSV output (first 300 chars):\n" + csvContent.slice(0, 300));

  // --- 4. Composite Feed -> Webhook -----------------------------------
  section("4. Composite Feed (Atlas + Reputation) -> Webhook POST");
  const compositeRunId = await engine.runFeed(orbit, orbit.feeds[0], { retryScheduleMsOverride: FAST_RETRY_SCHEDULE });
  await new Promise((r) => setTimeout(r, 200));
  console.log("Run log entry:", runLogger.get(compositeRunId));
  const compositeDelivered = deliveries[deliveries.length - 1].body as {
    components: Record<string, unknown>;
    component_status: Record<string, string>;
  };
  console.log("Component status:", compositeDelivered.component_status);
  console.log("Components present:", Object.keys(compositeDelivered.components));

  // --- 5. REST API: Delta Polling + Run Log endpoints --------------------
  section("5. REST API - Delta Polling + Run Log endpoints");
  const server = createServer(SAMPLE_CLIENTS, dataSource, runLogger);
  await new Promise<void>((resolve) => server.listen(API_PORT, resolve));
  const base = `http://localhost:${API_PORT}`;
  const solsticeKey = DEMO_API_KEYS["solstice-sg"];

  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const deltaRes = await fetch(`${base}/v2/feed/atlas?since=${since}`, {
    headers: { Authorization: `Bearer ${solsticeKey}` },
  });
  const deltaJson = (await deltaRes.json()) as { returned: number; has_more: boolean };
  console.log(`GET /v2/feed/atlas?since=... -> ${deltaRes.status}`, {
    returned: deltaJson.returned,
    has_more: deltaJson.has_more,
  });

  const runLogRes = await fetch(`${base}/v2/feed/runs`, {
    headers: { Authorization: `Bearer ${solsticeKey}` },
  });
  const runLogJson = (await runLogRes.json()) as { runs: unknown[] };
  console.log(`GET /v2/feed/runs -> ${runLogRes.status}`, `${runLogJson.runs.length} run(s) for solstice-sg`);

  const badKeyRes = await fetch(`${base}/v2/feed/atlas?since=${since}`, {
    headers: { Authorization: "Bearer not-a-real-key" },
  });
  console.log(`GET with invalid key -> ${badKeyRes.status} (expect 401)`);

  const wrongScopeRes = await fetch(`${base}/v2/feed/reputation?since=${since}`, {
    headers: { Authorization: `Bearer ${solsticeKey}` }, // solstice key is atlas-scoped only
  });
  console.log(`GET reputation with atlas-only key -> ${wrongScopeRes.status} (expect 403)`);

  const missingSinceRes = await fetch(`${base}/v2/feed/atlas`, {
    headers: { Authorization: `Bearer ${solsticeKey}` },
  });
  console.log(`GET without 'since' -> ${missingSinceRes.status} (expect 400)`);

  section("Demo complete");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
