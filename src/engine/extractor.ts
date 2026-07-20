// Data Extractor component (PRD §2.3). Calls the DataSource and wraps
// the result in the versioned envelope fields common to every feed type
// (run_id, run_at, client_id, schema_version).

import crypto from "crypto";
import { DataSource } from "../data/dataSource";
import { ClientConfig, FeedConfig } from "../types/config";
import {
  AtlasFeedPayload,
  AtlasFilters,
  CompositeFeedPayload,
  PipelineFilters,
  PipelineRecord,
  ReputationFeedPayload,
  ReputationFilters,
} from "../types/feed";
import { SCHEMA_VERSIONS } from "../config/constants";

function newRunId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class Extractor {
  constructor(private dataSource: DataSource) {}

  async extractPipeline(client: ClientConfig, filters: PipelineFilters): Promise<{ runId: string; runAt: string; rows: PipelineRecord[] }> {
    const runId = newRunId();
    const rows = await this.dataSource.getPipelineRecords(client.client_id, filters);
    return { runId, runAt: nowIso(), rows };
  }

  async extractAtlas(client: ClientConfig, filters: AtlasFilters): Promise<{ runId: string; runAt: string; object: AtlasFeedPayload }> {
    const runId = newRunId();
    const runAt = nowIso();
    const partial = await this.dataSource.runAtlas(client.client_id, filters);
    const object: AtlasFeedPayload = {
      feed_type: "atlas",
      schema_version: SCHEMA_VERSIONS.atlas,
      run_id: runId,
      run_at: runAt,
      client_id: client.client_id,
      ...partial,
    };
    return { runId, runAt, object };
  }

  async extractReputation(
    client: ClientConfig,
    filters: ReputationFilters
  ): Promise<{ runId: string; runAt: string; rows: ReputationFeedPayload[] }> {
    const runId = newRunId();
    const runAt = nowIso();
    const partials = await this.dataSource.runReputation(client.client_id, filters);
    const rows: ReputationFeedPayload[] = partials.map((p) => ({
      feed_type: "reputation",
      schema_version: SCHEMA_VERSIONS.reputation,
      run_id: runId,
      run_at: runAt,
      client_id: client.client_id,
      ...p,
    }));
    return { runId, runAt, rows };
  }

  // Composite Feed: bundles requested component feed types into one
  // envelope. Per PRD §3.4 recommendation, if any component fails, the
  // whole composite run is marked failed for the caller to retry as a
  // unit rather than delivering a partial payload (open item C7).
  async extractComposite(
    client: ClientConfig,
    components: ("pipeline" | "atlas" | "reputation")[],
    filters: { pipeline?: PipelineFilters; atlas?: AtlasFilters; reputation?: ReputationFilters }
  ): Promise<{ runId: string; runAt: string; object: CompositeFeedPayload; componentFailed: boolean }> {
    const runId = newRunId();
    const runAt = nowIso();
    const componentStatus: CompositeFeedPayload["component_status"] = {};
    const result: CompositeFeedPayload["components"] = {};
    let anyFailed = false;

    for (const component of components) {
      try {
        if (component === "pipeline" && filters.pipeline) {
          result.pipeline = await this.dataSource.getPipelineRecords(client.client_id, filters.pipeline);
          componentStatus.pipeline = "ok";
        } else if (component === "atlas" && filters.atlas) {
          const partial = await this.dataSource.runAtlas(client.client_id, filters.atlas);
          result.atlas = {
            feed_type: "atlas",
            schema_version: SCHEMA_VERSIONS.atlas,
            run_id: runId,
            run_at: runAt,
            client_id: client.client_id,
            ...partial,
          };
          componentStatus.atlas = "ok";
        } else if (component === "reputation" && filters.reputation) {
          const partials = await this.dataSource.runReputation(client.client_id, filters.reputation);
          result.reputation = partials.map((p) => ({
            feed_type: "reputation",
            schema_version: SCHEMA_VERSIONS.reputation,
            run_id: runId,
            run_at: runAt,
            client_id: client.client_id,
            ...p,
          }));
          componentStatus.reputation = "ok";
        }
      } catch (err) {
        componentStatus[component] = "failed";
        anyFailed = true;
      }
    }

    const object: CompositeFeedPayload = {
      feed_type: "composite",
      schema_version: SCHEMA_VERSIONS.composite,
      run_id: runId,
      run_at: runAt,
      client_id: client.client_id,
      components: result,
      component_status: componentStatus,
    };

    return { runId, runAt, object, componentFailed: anyFailed };
  }
}
