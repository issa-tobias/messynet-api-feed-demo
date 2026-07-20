// Feed Engine orchestrator (PRD §2.3): ties Extractor -> Formatter ->
// Delivery Agent -> Run Logger together for a single client/feed run.

import { ClientConfig, FeedConfig } from "../types/config";
import { DataSource } from "../data/dataSource";
import { Extractor } from "./extractor";
import { formatObject, formatRows } from "./formatter";
import { deliverCloudStorageDrop, deliverWebhookWithRetry, deadLetterQueue } from "./deliveryAgent";
import { runLogger } from "./runLogger";
import { RunLogEntry } from "../types/runLog";
import {
  AtlasFilters,
  FeedTypeName,
  PipelineFilters,
  ReputationFilters,
} from "../types/feed";

// Client delivery credentials, resolved at delivery time. In production
// both live in a secrets manager - never in the client config, which
// stores only the API key hash (PRD §6.1).
export interface WebhookSecretProvider {
  getSecret(clientId: string): string;
  getApiKey(clientId: string): string;
}

export class FeedEngine {
  constructor(private dataSource: DataSource, private extractor: Extractor, private secrets: WebhookSecretProvider) {}

  async runFeed(
    client: ClientConfig,
    feedConfig: FeedConfig,
    opts?: {
      retryScheduleMsOverride?: number[];
      // Fires as soon as the run exists in the run log - callers that
      // want to observe delivery progress (retries can span hours on the
      // production schedule) get the run_id without waiting for the
      // delivery to reach a terminal state.
      onRunCreated?: (runId: string) => void;
    }
  ): Promise<string> {
    const { feed_type, delivery } = feedConfig;

    let runId: string;
    let runAt: string;
    let rows: Record<string, unknown>[] | undefined;
    let object: Record<string, unknown> | undefined;
    let extractionFailed = false;

    if (feed_type === "pipeline") {
      const result = await this.extractor.extractPipeline(client, feedConfig.query_params as PipelineFilters);
      runId = result.runId;
      runAt = result.runAt;
      rows = result.rows as unknown as Record<string, unknown>[];
    } else if (feed_type === "atlas") {
      const result = await this.extractor.extractAtlas(client, feedConfig.query_params as AtlasFilters);
      runId = result.runId;
      runAt = result.runAt;
      object = result.object as unknown as Record<string, unknown>;
    } else if (feed_type === "reputation") {
      const result = await this.extractor.extractReputation(client, feedConfig.query_params as ReputationFilters);
      runId = result.runId;
      runAt = result.runAt;
      rows = result.rows as unknown as Record<string, unknown>[];
    } else {
      const components = feedConfig.composite_components ?? [];
      const result = await this.extractor.extractComposite(
        client,
        components,
        feedConfig.composite_query_params ?? {}
      );
      runId = result.runId;
      runAt = result.runAt;
      object = result.object as unknown as Record<string, unknown>;
      extractionFailed = Boolean(result.componentFailed);
    }

    const logEntry: RunLogEntry = {
      run_id: runId,
      client_id: client.client_id,
      feed_type,
      scheduled_at: runAt,
      delivered_at: null,
      status: "pending",
      delivery_mechanism: delivery.mechanism,
      attempt_count: 0,
    };
    runLogger.create(logEntry);
    opts?.onRunCreated?.(runId);

    if (extractionFailed) {
      // PRD §3.4 recommendation: "fail-and-retry the full payload to
      // prevent partial state on the client side." Extraction-layer
      // failure (a component's data wasn't ready) is distinct from a
      // delivery-layer failure - no partial payload is ever handed to
      // the Delivery Agent. The scheduled cadence's next run acts as the
      // retry; the failure is logged and alerted immediately.
      runLogger.update(runId, { status: "failed", error: "one or more composite components failed extraction" });
      deadLetterQueue.add({
        run_id: runId,
        client_id: client.client_id,
        feed_type,
        last_error: "composite component extraction failure",
        failed_at: new Date().toISOString(),
        attempt_count: 0,
      });
      return runId;
    }

    if (delivery.mechanism === "delta") {
      // Delta Polling is pull-only - nothing to push. The extraction
      // still ran (e.g. for a scheduled cache warm) but delivery is the
      // client's GET request, handled by the Delta Polling route.
      runLogger.update(runId, { status: "success", delivered_at: new Date().toISOString(), attempt_count: 1 });
      return runId;
    }

    const format = delivery.format;
    const formatted = rows ? await formatRows(rows, format) : await formatObject(object!, format);

    if (delivery.mechanism === "webhook") {
      const secret = delivery.hmac_enabled ? this.secrets.getSecret(client.client_id) : undefined;
      await deliverWebhookWithRetry({
        runId,
        clientId: client.client_id,
        feedType: feed_type,
        schemaVersion: `${feed_type}-v1`,
        config: delivery,
        apiKey: this.secrets.getApiKey(client.client_id),
        webhookSecret: secret,
        body: formatted.body,
        retryScheduleMsOverride: opts?.retryScheduleMsOverride,
      });
    } else {
      const result = await deliverCloudStorageDrop({
        runId,
        clientId: client.client_id,
        feedType: feed_type,
        config: delivery,
        body: formatted.body,
        extension: formatted.extension,
      });
      if (result.ok) {
        runLogger.update(runId, { status: "success", delivered_at: new Date().toISOString(), attempt_count: 1 });
      } else {
        runLogger.update(runId, { status: "failed", attempt_count: 1, error: result.error });
        deadLetterQueue.add({
          run_id: runId,
          client_id: client.client_id,
          feed_type,
          last_error: result.error ?? "unknown cloud storage error",
          failed_at: new Date().toISOString(),
          attempt_count: 1,
        });
      }
    }

    return runId;
  }
}
