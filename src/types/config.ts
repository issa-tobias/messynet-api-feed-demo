// Client configuration types per PRD §9.2 (Client Configuration Object).

import { AtlasFilters, FeedTypeName, PipelineFilters, ReputationFilters } from "./feed";

export type DeliveryMechanism = "webhook" | "cloud_storage" | "delta";
export type DeliveryFormat = "json" | "ndjson" | "csv" | "parquet";
export type SlaTier = "standard" | "enterprise" | "enterprise_plus";

export interface WebhookDeliveryConfig {
  mechanism: "webhook";
  endpoint: string; // must be HTTPS (PRD §6.1)
  format: DeliveryFormat;
  hmac_enabled: boolean;
}

export interface CloudStorageDeliveryConfig {
  mechanism: "cloud_storage";
  provider: "s3" | "gcs" | "azure_blob";
  bucket: string;
  format: DeliveryFormat;
}

export interface DeltaDeliveryConfig {
  // Delta Polling has no push delivery config - the client pulls from
  // GET /v2/feed/{feed_type}. Included so a feed can be marked
  // "available via delta" without also configuring a push mechanism.
  mechanism: "delta";
}

export type DeliveryConfig =
  | WebhookDeliveryConfig
  | CloudStorageDeliveryConfig
  | DeltaDeliveryConfig;

export type FeedFilters = PipelineFilters | AtlasFilters | ReputationFilters;

export interface CompositeComponentFilters {
  pipeline?: PipelineFilters;
  atlas?: AtlasFilters;
  reputation?: ReputationFilters;
}

export interface FeedConfig {
  feed_type: FeedTypeName;
  schema_version: string; // e.g. "1" -> resolved to "atlas-v1" via registry
  cadence: string; // cron syntax, e.g. "0 0 * * *"
  // Required for pipeline/atlas/reputation feeds. Composite feeds use
  // composite_query_params instead, since each bundled component needs
  // its own filter shape (Atlas needs platforms/region, Reputation needs
  // brands - they can't share one query_params object).
  query_params?: FeedFilters;
  composite_query_params?: CompositeComponentFilters;
  delivery: DeliveryConfig;
  // Only present when feed_type === "composite". Composite cannot nest
  // another composite as a component.
  composite_components?: ("pipeline" | "atlas" | "reputation")[];
}

export interface ClientAuthConfig {
  api_key_id: string;
  api_key_hash: string; // sha256 of the raw key; raw key is never stored
  scopes: string[]; // e.g. ["atlas:read", "pipeline:read"]
}

export interface ClientConfig {
  client_id: string;
  client_name: string;
  feeds: FeedConfig[];
  auth: ClientAuthConfig;
  sla_tier: SlaTier;
  technical_contact: string;
  contract_start: string; // ISO date
  schema_locked_at: string; // ISO date
}
