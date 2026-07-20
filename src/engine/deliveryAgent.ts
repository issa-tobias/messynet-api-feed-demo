// Delivery Agent component (PRD §2.3, §4.1 Webhook POST, §4.2 Cloud
// Storage Drop, §6.2 HMAC, §7.2 Retry Policy).

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { CloudStorageDeliveryConfig, DeliveryFormat, WebhookDeliveryConfig } from "../types/config";
import { RunLogEntry } from "../types/runLog";
import { MAX_DELIVERY_ATTEMPTS, RETRY_SCHEDULE_MS, WEBHOOK_TIMEOUT_MS } from "../config/constants";
import { runLogger } from "./runLogger";
import { FeedTypeName } from "../types/feed";

export interface DeadLetterEntry {
  run_id: string;
  client_id: string;
  feed_type: FeedTypeName;
  last_error: string;
  failed_at: string;
  attempt_count: number;
  // Everything needed to re-attempt the delivery later. PRD §7.2:
  // "Client can request a manual re-delivery of the failed run" - without
  // the original payload and delivery config retained here, the DLQ would
  // only be a record of failure, not a recovery mechanism.
  redelivery?: Omit<DeliverWebhookRunParams, "retryScheduleMsOverride">;
}

class DeadLetterQueue {
  private entries: DeadLetterEntry[] = [];

  add(entry: DeadLetterEntry): void {
    // A re-failed redelivery replaces its older entry instead of piling up.
    this.entries = this.entries.filter((e) => e.run_id !== entry.run_id);
    this.entries.push(entry);
    // PRD §7.2: "MessyNet sends an alert to the technical contact on
    // file" after final failure. Stubbed as a log line; a real build
    // wires this to the alerting/paging system.
    // eslint-disable-next-line no-console
    console.error(
      `[ALERT] Delivery failed after ${entry.attempt_count} attempts for client=${entry.client_id} feed=${entry.feed_type} run=${entry.run_id}: ${entry.last_error}`
    );
  }

  get(runId: string): DeadLetterEntry | undefined {
    return this.entries.find((e) => e.run_id === runId);
  }

  remove(runId: string): void {
    this.entries = this.entries.filter((e) => e.run_id !== runId);
  }

  list(): DeadLetterEntry[] {
    return [...this.entries];
  }
}

export const deadLetterQueue = new DeadLetterQueue();

// Manual re-delivery of a dead-lettered run (PRD §7.2). Replays the stored
// payload through the normal retry pipeline; on success the DLQ entry is
// dropped, on another exhausted retry cycle add() replaces it in place.
export async function redeliverFromDeadLetter(
  runId: string,
  retryScheduleMsOverride?: number[]
): Promise<{ ok: boolean; error?: string }> {
  const entry = deadLetterQueue.get(runId);
  if (!entry) return { ok: false, error: `run_id ${runId} is not in the dead-letter queue` };
  if (!entry.redelivery) return { ok: false, error: `run_id ${runId} has no stored payload to re-deliver` };
  await deliverWebhookWithRetry({ ...entry.redelivery, retryScheduleMsOverride });
  const after = runLogger.get(runId);
  if (after?.status === "success") {
    deadLetterQueue.remove(runId);
    return { ok: true };
  }
  return { ok: false, error: after?.error ?? "redelivery failed" };
}

export function signHmac(secret: string, rawBody: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WebhookAttemptParams {
  config: WebhookDeliveryConfig;
  body: string | Buffer;
  headers: Record<string, string>;
}

function isAllowedEndpoint(endpoint: string): boolean {
  if (endpoint.startsWith("https://")) return true;
  // Demo/local-testing-only escape hatch so the end-to-end demo can POST
  // to a receiver running on localhost without standing up TLS. Never
  // satisfied in production - requires an explicit env var plus an
  // explicit localhost endpoint.
  const demoAllowed = process.env.ALLOW_INSECURE_WEBHOOKS_FOR_DEMO === "true";
  return demoAllowed && /^http:\/\/(localhost|127\.0\.0\.1)/.test(endpoint);
}

async function attemptWebhookPost({ config, body, headers }: WebhookAttemptParams): Promise<{ ok: boolean; error?: string }> {
  if (!isAllowedEndpoint(config.endpoint)) {
    // PRD §4.1/§6.1: "HTTPS required. Plain HTTP endpoints will be rejected."
    return { ok: false, error: "endpoint is not HTTPS; rejected per client requirements" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    // "MessyNet treats any 2xx HTTP status code as successful delivery."
    if (res.status >= 200 && res.status < 300) {
      return { ok: true };
    }
    return { ok: false, error: `endpoint returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface DeliverWebhookRunParams {
  runId: string;
  clientId: string;
  feedType: FeedTypeName;
  schemaVersion: string; // e.g. "atlas-v1", used in X-MessyNet-Feed
  config: WebhookDeliveryConfig;
  apiKey: string; // client-scoped key sent as X-MessyNet-Key (PRD §6.1)
  webhookSecret?: string; // required if config.hmac_enabled
  body: string | Buffer;
  // Test-only override of the retry backoff schedule so demos/tests don't
  // have to wait 8+ hours for a final failure. Production always uses
  // RETRY_SCHEDULE_MS.
  retryScheduleMsOverride?: number[];
}

export async function deliverWebhookWithRetry(params: DeliverWebhookRunParams): Promise<void> {
  const schedule = params.retryScheduleMsOverride ?? RETRY_SCHEDULE_MS;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-MessyNet-Key": params.apiKey,
    "X-MessyNet-Feed": params.schemaVersion,
    "X-MessyNet-Run-ID": params.runId,
    "X-MessyNet-Timestamp": new Date().toISOString(),
  };
  if (params.config.hmac_enabled) {
    if (!params.webhookSecret) {
      throw new Error("hmac_enabled is true but no webhookSecret was provided");
    }
    headers["X-MessyNet-Signature"] = signHmac(params.webhookSecret, String(params.body));
  }

  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    if (schedule[attempt] > 0) {
      runLogger.update(params.runId, { status: "retrying", attempt_count: attempt + 1 });
      await sleep(schedule[attempt]);
    }
    const result = await attemptWebhookPost({ config: params.config, body: params.body, headers });
    if (result.ok) {
      runLogger.update(params.runId, {
        status: "success",
        delivered_at: new Date().toISOString(),
        attempt_count: attempt + 1,
      });
      return;
    }
    runLogger.update(params.runId, {
      status: attempt === MAX_DELIVERY_ATTEMPTS - 1 ? "failed" : "retrying",
      attempt_count: attempt + 1,
      error: result.error,
    });
    if (attempt === MAX_DELIVERY_ATTEMPTS - 1) {
      const { retryScheduleMsOverride: _omitted, ...redelivery } = params;
      deadLetterQueue.add({
        run_id: params.runId,
        client_id: params.clientId,
        feed_type: params.feedType,
        last_error: result.error ?? "unknown error",
        failed_at: new Date().toISOString(),
        attempt_count: attempt + 1,
        redelivery,
      });
    }
  }
}

// --- Cloud Storage Drop (§4.2) --------------------------------------------
//
// Simulated locally under .data-drops/ using the exact naming convention
// from the PRD: {bucket}/{client_id}/{feed_type}/{YYYY-MM-DD}/{run_id}.{format}
// Swapping this for real S3/GCS/Azure SDK calls only touches this function.

const DROP_ROOT = path.join(process.cwd(), ".data-drops");

export async function deliverCloudStorageDrop(params: {
  runId: string;
  clientId: string;
  feedType: FeedTypeName;
  config: CloudStorageDeliveryConfig;
  body: string | Buffer;
  extension: string;
}): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const dateStr = new Date().toISOString().slice(0, 10);
  // Writes are idempotent: same run_id always writes to the same file
  // path (PRD §4.2 Delivery guarantee) - retried runs overwrite.
  const relativePath = path.join(
    params.config.provider,
    params.config.bucket,
    params.clientId,
    params.feedType,
    dateStr,
    `${params.runId}.${params.extension}`
  );
  const fullPath = path.join(DROP_ROOT, relativePath);
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, params.body);
    return { ok: true, filePath: relativePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
