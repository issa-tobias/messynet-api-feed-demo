// The extraction boundary between the Feed Engine and wherever the actual
// data lives. Per PRD §2.3, the Feed Engine "queries same MongoDB/processing
// layer as Data API v2" - this interface is that seam. MockDataSource below
// satisfies it with generated data; a real implementation would query
// MongoDB (pipeline), invoke Atlas, and invoke MessyRep (reputation)
// without any change to engine/extractor.ts or anything downstream of it.

import {
  AtlasFeedPayload,
  AtlasFilters,
  PipelineFilters,
  PipelineRecord,
  ReputationFeedPayload,
  ReputationFilters,
} from "../types/feed";

export interface DataSource {
  getPipelineRecords(clientId: string, filters: PipelineFilters): Promise<PipelineRecord[]>;
  runAtlas(clientId: string, filters: AtlasFilters): Promise<Omit<AtlasFeedPayload, "feed_type" | "schema_version" | "run_id" | "run_at" | "client_id">>;
  runReputation(
    clientId: string,
    filters: ReputationFilters
  ): Promise<Omit<ReputationFeedPayload, "feed_type" | "schema_version" | "run_id" | "run_at" | "client_id">[]>;
}
