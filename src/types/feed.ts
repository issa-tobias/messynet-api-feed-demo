// Feed payload types per PRD §3 (Feed Types) and §5 (API Schema & Versioning).

export type Platform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "tiktok"
  | "youtube"
  | "reddit"
  | "twitter";

export type MediaType = "text" | "image" | "video" | "reel" | "story" | "article";

export type FeedTypeName = "pipeline" | "atlas" | "reputation" | "composite";

// --- 3.1 Pipeline Feed -------------------------------------------------

export interface PipelineRecord {
  post_id: string;
  platform: Platform;
  created_at: string; // ISO 8601 datetime
  collected_at: string; // ISO 8601 datetime
  text: string | null;
  author: {
    id: string;
    name: string | null;
    subscriber_count: number | null;
  };
  engagement: {
    likes: number;
    comments: number;
    shares: number | null;
    views: number | null;
  };
  region: string;
  requested_by: string;
  language: string | null; // ISO 639-1
  media_type: MediaType;
  raw_data: Record<string, unknown>;
}

// --- 3.2 Atlas Intelligence Feed ----------------------------------------

export interface TopNode {
  post_id: string;
  platform: Platform;
  engagement: number;
}

export interface Community {
  id: string;
  size: number;
  top_nodes: TopNode[];
  // Narratives are only generated for the top 5 communities by edge-weight
  // connectivity (PRD §3.2 VALIDATE — Narrative field availability, C9).
  // Recommended default per PRD: always include the field, null when not
  // generated, rather than omitting it. Traceable to open item C9.
  narrative: string | null;
  sentiment: number; // VADER, -1 to +1
  platform_breakdown: Partial<Record<Platform, number>>;
}

export interface BridgeNode {
  post_id: string;
  platform: Platform;
  community_connections: string[];
  text_preview: string; // first 200 chars
}

export interface Amplifier {
  author_id: string;
  reach_score: number; // 0-1
}

export interface AtlasFeedPayload {
  feed_type: "atlas";
  schema_version: string; // e.g. "atlas-v1"
  run_id: string;
  run_at: string;
  client_id: string;
  query_params: {
    platforms: Platform[];
    region: string[];
    language?: string[];
    date_range?: { from: string; to: string };
  };
  post_count: number;
  communities: Community[];
  bridge_nodes: BridgeNode[];
  amplifiers: Amplifier[];
  top_narrative: string;
  sentiment_distribution: { positive: number; neutral: number; negative: number };
  language_distribution: Record<string, number>;
}

// --- 3.3 Reputation Feed --------------------------------------------------

export interface ReputationArticle {
  url: string;
  source: string;
  published_at: string; // ISO 8601 date
  article_score: number;
}

export interface ReputationFeedPayload {
  feed_type: "reputation";
  schema_version: string; // e.g. "reputation-v1"
  run_id: string;
  run_at: string;
  client_id: string;
  brand: string;
  brand_score: number; // 0-1
  score_delta: number; // +/- vs prior run. Emit as a plain number (no
  // leading "+"): PRD §5.5 sample has "+0.031" which is invalid JSON.
  article_count: number;
  sentiment_score: number;
  coverage_score: number;
  relevance_score: number;
  age_score: number;
  weights_applied: {
    sentiment_weight: number;
    coverage_weight: number;
    relevance_weight: number;
    age_weight: number;
  };
  article_retention_days: number; // minimum 30
  age_half_life_days: number; // minimum 1
  top_articles: ReputationArticle[]; // top 5 by weighted score
  data_source: "google_news"; // MessyRep scores Google News only (v1 scope limit)
}

// --- 3.4 Composite Feed -----------------------------------------------
//
// The PRD leaves the Composite Feed schema as "documented per contract"
// with no baseline envelope. That leaves §5.1's schema-stability
// commitments (no field removal, 30-day breaking-change notice) with
// nothing concrete to apply to for this feed type. This defines a minimal
// stable envelope; the *contents* of each component remain that
// component's own versioned schema.

export interface CompositeFeedPayload {
  feed_type: "composite";
  schema_version: string; // e.g. "composite-v1"
  run_id: string;
  run_at: string;
  client_id: string;
  components: {
    pipeline?: PipelineRecord[];
    atlas?: AtlasFeedPayload;
    reputation?: ReputationFeedPayload[];
  };
  // If any requested component failed, per PRD recommendation (§3.4,
  // "fail-and-retry the full payload"), the whole composite run fails
  // and is retried rather than delivering partially. This field exists
  // for observability only — a failed run never reaches delivery.
  component_status: Partial<Record<"pipeline" | "atlas" | "reputation", "ok" | "failed">>;
}

export type FeedPayload =
  | { feed_type: "pipeline"; schema_version: string; records: PipelineRecord[] }
  | AtlasFeedPayload
  | { feed_type: "reputation"; schema_version: string; records: ReputationFeedPayload[] }
  | CompositeFeedPayload;

// --- Filters (§3.1 "Filters available at contract time") -----------------

export interface PipelineFilters {
  platform?: Platform[];
  region?: string[];
  language?: string[];
  media_type?: MediaType[];
  date_range?: { from: string; to: string };
  // Keyword/hashtag filtering explicitly excluded from v1 per PRD
  // recommendation (open item C10) - deferred to v1.1.
}

export interface AtlasFilters {
  platforms: Platform[];
  region: string[];
  language?: string[];
  date_range?: { from: string; to: string };
}

export interface ReputationFilters {
  brands: string[]; // max 10 per client account (MAX_BRANDS, PRD §3.3)
}
