// Delta Polling Endpoint (PRD §4.3): GET /v2/feed/{feed_type}?since=...
//
// Cursor-based pagination, default/limit caps and max lookback window
// per PRD (§4.3, §8). Composite is intentionally excluded - the PRD only
// shows pipeline/atlas/reputation on this endpoint; composite is a
// push-only bundling concept (§3.4).

import crypto from "crypto";
import { NextFunction, Router, Response } from "express";
import { AuthedRequest, requireScope } from "../middleware/auth";
import { deltaRateLimit } from "../middleware/rateLimit";
import { DataSource } from "../../data/dataSource";
import { SCHEMA_VERSIONS } from "../../config/constants";
import { DELTA_DEFAULT_LIMIT, DELTA_MAX_LOOKBACK_DAYS, RATE_LIMITS } from "../../config/constants";
import { AtlasFilters, PipelineFilters, Platform, ReputationFilters } from "../../types/feed";

const DELTA_FEED_TYPES = ["pipeline", "atlas", "reputation"];
const VALID_PLATFORMS: Platform[] = ["facebook", "instagram", "linkedin", "tiktok", "youtube", "reddit", "twitter"];

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== "string") return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof decoded.offset === "number" && decoded.offset >= 0 ? decoded.offset : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function csvParam(v: unknown): string[] | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.split(",").map((s) => s.trim());
}

// Synthesizes plausible run timestamps between `since` and now, standing
// in for "runs that occurred in this window" against the mock data
// layer (which has no persistent run history to query directly).
function synthesizeRunTimestamps(since: Date, now: Date, maxRuns: number): string[] {
  const spanMs = now.getTime() - since.getTime();
  if (spanMs <= 0) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const count = Math.max(1, Math.min(maxRuns, Math.ceil(spanMs / dayMs)));
  const timestamps: string[] = [];
  for (let i = 1; i <= count; i++) {
    const t = new Date(since.getTime() + (spanMs * i) / (count + 1));
    timestamps.push(t.toISOString().replace(/\.\d{3}Z$/, "Z"));
  }
  return timestamps;
}

// Deterministic run_id for a synthesized run: the same client + feed +
// run timestamp always maps to the same id, so an analyst re-fetching
// the same window (or paginating across it) sees stable identifiers and
// can deduplicate on run_id as the PRD's idempotency guidance assumes.
function deterministicRunId(clientId: string, feedType: string, runAt: string): string {
  const h = crypto.createHash("sha256").update(`${clientId}:${feedType}:${runAt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Feed-type existence is checked before scope: an unknown feed type is a
// 404 regardless of what the key is scoped for. (Previously the scope
// middleware ran first, so /v2/feed/telegram returned a misleading 403
// "not scoped for telegram:read" instead of 404.)
function validateFeedType(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!DELTA_FEED_TYPES.includes(req.params.feedType)) {
    res.status(404).json({ error: "not_found", message: `Unknown feed_type "${req.params.feedType}"` });
    return;
  }
  next();
}

export function createDeltaFeedRouter(dataSource: DataSource): Router {
  const router = Router();

  router.get(
    "/v2/feed/:feedType",
    validateFeedType,
    deltaRateLimit,
    requireScope((req) => `${req.params.feedType}:read`),
    async (req: AuthedRequest, res: Response) => {
      const { feedType } = req.params;
      const client = req.client!;

      const sinceRaw = req.query.since;
      if (typeof sinceRaw !== "string") {
        res.status(400).json({ error: "bad_request", message: "Query param 'since' (ISO8601) is required" });
        return;
      }
      const since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) {
        res.status(400).json({ error: "bad_request", message: "'since' is not a valid ISO8601 timestamp" });
        return;
      }
      const now = new Date();
      const maxLookback = new Date(now.getTime() - DELTA_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      if (since < maxLookback) {
        res.status(400).json({
          error: "bad_request",
          message: `'since' exceeds the maximum lookback window of ${DELTA_MAX_LOOKBACK_DAYS} days`,
        });
        return;
      }

      // 'limit', when provided, must be a positive integer. Silently
      // coercing bad values corrupted pagination: limit=-5 produced an
      // empty page with has_more=true and a negative-offset cursor.
      let requestedLimit = DELTA_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        const parsed = Number(req.query.limit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          res.status(400).json({ error: "bad_request", message: "'limit' must be a positive integer" });
          return;
        }
        requestedLimit = parsed;
      }
      const tierLimits = RATE_LIMITS[client.sla_tier];
      const limit = Math.min(requestedLimit, tierLimits.deltaRecordsPerResponse);
      const offset = decodeCursor(req.query.cursor);

      // Platform values are a contract enum (PRD §3.1) - reject unknown
      // ones instead of passing them through (the mock would otherwise
      // fabricate records with invalid platform values).
      const platformParam = csvParam(req.query.platform);
      if (platformParam) {
        const invalid = platformParam.filter((p) => !VALID_PLATFORMS.includes(p as Platform));
        if (invalid.length) {
          res.status(400).json({
            error: "bad_request",
            message: `Unknown platform(s): ${invalid.join(", ")}. Valid: ${VALID_PLATFORMS.join(", ")}`,
          });
          return;
        }
      }

      let allData: unknown[];

      if (feedType === "pipeline") {
        const filters: PipelineFilters = {
          platform: platformParam as PipelineFilters["platform"],
          region: csvParam(req.query.region),
          language: csvParam(req.query.language),
        };
        const records = await dataSource.getPipelineRecords(client.client_id, filters);
        allData = records
          .filter((r) => new Date(r.created_at) >= since)
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      } else if (feedType === "atlas") {
        const filters: AtlasFilters = {
          platforms: (platformParam as AtlasFilters["platforms"]) ?? [],
          region: csvParam(req.query.region) ?? [],
        };
        const runTimestamps = synthesizeRunTimestamps(since, now, 5);
        allData = await Promise.all(
          runTimestamps.map(async (run_at) => {
            const partial = await dataSource.runAtlas(client.client_id, filters);
            return {
              feed_type: "atlas",
              schema_version: SCHEMA_VERSIONS.atlas,
              run_id: deterministicRunId(client.client_id, "atlas", run_at),
              run_at,
              client_id: client.client_id,
              ...partial,
            };
          })
        );
      } else {
        // Default to the brands the client actually has under contract
        // (their feed config), not a placeholder. A brand query param
        // narrows within that; with neither, the request is unanswerable.
        const configuredBrands =
          (client.feeds.find((f) => f.feed_type === "reputation")?.query_params as ReputationFilters | undefined)
            ?.brands ??
          client.feeds.find((f) => f.feed_type === "composite")?.composite_query_params?.reputation?.brands;
        const brands = csvParam(req.query.brand) ?? configuredBrands;
        if (!brands || brands.length === 0) {
          res.status(400).json({
            error: "bad_request",
            message: "No brands configured for this client - pass ?brand=<name> or configure a reputation feed",
          });
          return;
        }
        const filters: ReputationFilters = { brands };
        const runTimestamps = synthesizeRunTimestamps(since, now, 5);
        const nested = await Promise.all(
          runTimestamps.map(async (run_at) => {
            const partials = await dataSource.runReputation(client.client_id, filters);
            return partials.map((p) => ({
              feed_type: "reputation",
              schema_version: SCHEMA_VERSIONS.reputation,
              run_id: deterministicRunId(client.client_id, "reputation", run_at),
              run_at,
              client_id: client.client_id,
              ...p,
            }));
          })
        );
        allData = nested.flat();
      }

      const page = allData.slice(offset, offset + limit);
      const hasMore = offset + limit < allData.length;

      res.json({
        feed_type: feedType,
        since: sinceRaw,
        returned: page.length,
        has_more: hasMore,
        next_cursor: hasMore ? encodeCursor(offset + limit) : null,
        data: page,
      });
    }
  );

  return router;
}
