import { DataSource } from "./dataSource";
import { Rng } from "./rng";
import {
  AtlasFeedPayload,
  AtlasFilters,
  BridgeNode,
  Community,
  MediaType,
  Platform,
  PipelineFilters,
  PipelineRecord,
  ReputationFeedPayload,
  ReputationFilters,
} from "../types/feed";

const ALL_PLATFORMS: Platform[] = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "youtube",
  "reddit",
  "twitter",
];
const ALL_MEDIA_TYPES: MediaType[] = ["text", "image", "video", "reel", "story", "article"];
const ALL_LANGUAGES = ["en", "tl", "zh", "id", "th"];

const NARRATIVE_THEMES = [
  "Consumer trust in financial products recovering post-quarter uncertainty",
  "Sustained interest in EV adoption incentives across the region",
  "Rising skepticism toward loyalty program changes",
  "Positive sentiment shift following product recall resolution",
  "Growing cross-platform discussion of data privacy practices",
  "Increased engagement around regional holiday promotions",
];

const NEWS_SOURCES = ["The Straits Times", "Channel News Asia", "Reuters", "Financial Times", "Nikkei Asia"];

function isoAt(daysAgo: number, hour = 0, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class MockDataSource implements DataSource {
  async getPipelineRecords(clientId: string, filters: PipelineFilters): Promise<PipelineRecord[]> {
    const rng = new Rng(`${clientId}:pipeline:${nowIso().slice(0, 13)}`);
    const platforms = filters.platform?.length ? filters.platform : ALL_PLATFORMS;
    const regions = filters.region?.length ? filters.region : ["sg"];
    const languages = filters.language?.length ? filters.language : ALL_LANGUAGES;
    const mediaTypes = filters.media_type?.length ? filters.media_type : ALL_MEDIA_TYPES;

    const count = rng.int(40, 120);
    const records: PipelineRecord[] = [];
    for (let i = 0; i < count; i++) {
      const platform = rng.pick(platforms);
      const isVideo = ["tiktok", "youtube"].includes(platform);
      const mediaType = isVideo ? rng.pick(["video", "reel"] as MediaType[]) : rng.pick(mediaTypes);
      records.push({
        post_id: `${platform.slice(0, 2)}_${rng.hex(10)}`,
        platform,
        created_at: isoAt(rng.int(0, 6), rng.int(0, 23), rng.int(0, 59)),
        collected_at: nowIso(),
        text: mediaType === "image" ? null : `Sample ${platform} post body #${i} about the tracked topic set.`,
        author: {
          id: `${platform}_user_${rng.int(1000, 9999)}`,
          name: rng.bool(0.8) ? `User${rng.int(100, 999)}` : null,
          subscriber_count: rng.bool(0.7) ? rng.int(50, 500_000) : null,
        },
        engagement: {
          likes: rng.int(0, 5000),
          comments: rng.int(0, 400),
          shares: rng.bool(0.85) ? rng.int(0, 800) : null,
          views: isVideo ? rng.int(500, 200_000) : null,
        },
        region: rng.pick(regions),
        requested_by: clientId,
        language: rng.bool(0.9) ? rng.pick(languages) : null,
        media_type: mediaType,
        raw_data: { _mock: true, platform_native_id: rng.hex(32) },
      });
    }
    return records;
  }

  async runAtlas(
    clientId: string,
    filters: AtlasFilters
  ): Promise<Omit<AtlasFeedPayload, "feed_type" | "schema_version" | "run_id" | "run_at" | "client_id">> {
    const rng = new Rng(`${clientId}:atlas:${nowIso().slice(0, 10)}`);
    const platforms = filters.platforms.length ? filters.platforms : ALL_PLATFORMS;
    const region = filters.region.length ? filters.region : ["sg"];

    const communityCount = rng.int(3, 7);
    const communities: Community[] = [];
    let totalPosts = 0;

    for (let i = 0; i < communityCount; i++) {
      const size = rng.int(80, 900);
      totalPosts += size;
      const breakdown: Partial<Record<Platform, number>> = {};
      let remaining = size;
      platforms.forEach((p, idx) => {
        const share = idx === platforms.length - 1 ? remaining : Math.floor(size * rng.float(0.1, 0.5));
        breakdown[p] = Math.min(share, remaining);
        remaining -= breakdown[p]!;
      });

      // Narrative generation runs on the top 5 communities by connectivity
      // (PRD §3.2 open item C9). Modeled here as: communities beyond the
      // 5th (by size, as a proxy for connectivity in this mock) get a null
      // narrative rather than being omitted from the array.
      const getsNarrative = i < 5;

      communities.push({
        id: `c${i + 1}`,
        size,
        top_nodes: Array.from({ length: 5 }, () => ({
          post_id: `${rng.pick(platforms).slice(0, 2)}_${rng.hex(8)}`,
          platform: rng.pick(platforms),
          engagement: rng.int(200, 5000),
        })),
        narrative: getsNarrative ? rng.pick(NARRATIVE_THEMES) : null,
        sentiment: rng.float(-1, 1),
        platform_breakdown: breakdown,
      });
    }

    const bridgeCount = rng.int(2, 5);
    const bridgeNodes: BridgeNode[] = Array.from({ length: bridgeCount }, () => {
      const connections = [rng.pick(communities).id, rng.pick(communities).id];
      return {
        post_id: `${rng.pick(platforms).slice(0, 2)}_${rng.hex(8)}`,
        platform: rng.pick(platforms),
        community_connections: Array.from(new Set(connections)),
        text_preview: "This is why I switched my approach after seeing the wider discussion...".slice(0, 200),
      };
    });

    const amplifierCount = rng.int(3, 8);
    const amplifiers = Array.from({ length: amplifierCount }, () => ({
      author_id: `${rng.pick(platforms)}_user_${rng.int(1000, 9999)}`,
      reach_score: rng.float(0.3, 0.98),
    }));

    const positive = rng.float(0.25, 0.55);
    const negative = rng.float(0.1, 0.35);
    const neutral = Math.max(0, 1 - positive - negative);

    const languageDist: Record<string, number> = {};
    ALL_LANGUAGES.forEach((lang) => (languageDist[lang] = rng.int(5, 40)));

    return {
      query_params: { platforms, region, language: filters.language, date_range: filters.date_range },
      post_count: totalPosts,
      communities: communities.sort((a, b) => b.size - a.size),
      bridge_nodes: bridgeNodes,
      amplifiers,
      top_narrative: communities[0]?.narrative ?? NARRATIVE_THEMES[0],
      sentiment_distribution: {
        positive: Number(positive.toFixed(2)),
        neutral: Number(neutral.toFixed(2)),
        negative: Number(negative.toFixed(2)),
      },
      language_distribution: languageDist,
    };
  }

  async runReputation(
    clientId: string,
    filters: ReputationFilters
  ): Promise<
    Omit<ReputationFeedPayload, "feed_type" | "schema_version" | "run_id" | "run_at" | "client_id">[]
  > {
    const brands = filters.brands.slice(0, 10); // MAX_BRANDS enforced (PRD §3.3)
    return brands.map((brand) => {
      const rng = new Rng(`${clientId}:reputation:${brand}:${nowIso().slice(0, 10)}`);
      const sentiment_score = rng.float(0.4, 0.9);
      const coverage_score = rng.float(0.4, 0.9);
      const relevance_score = rng.float(0.4, 0.95);
      const age_score = rng.float(0.4, 0.9);
      const weights = { sentiment_weight: 0.5, coverage_weight: 0.5, relevance_weight: 0.5, age_weight: 0.5 };
      const brand_score = Number(
        (
          (sentiment_score * weights.sentiment_weight +
            coverage_score * weights.coverage_weight +
            relevance_score * weights.relevance_weight +
            age_score * weights.age_weight) /
          4
        ).toFixed(3)
      );

      return {
        brand,
        brand_score,
        score_delta: Number(rng.float(-0.05, 0.05).toFixed(3)),
        article_count: rng.int(8, 60),
        sentiment_score: Number(sentiment_score.toFixed(2)),
        coverage_score: Number(coverage_score.toFixed(2)),
        relevance_score: Number(relevance_score.toFixed(2)),
        age_score: Number(age_score.toFixed(2)),
        weights_applied: weights,
        article_retention_days: 30,
        age_half_life_days: 14,
        top_articles: Array.from({ length: 5 }, (_, i) => ({
          url: `https://example-news.test/${brand.toLowerCase().replace(/\s+/g, "-")}/${i}`,
          source: rng.pick(NEWS_SOURCES),
          published_at: isoAt(rng.int(0, 29)).slice(0, 10),
          article_score: Number(rng.float(0.3, 0.95).toFixed(2)),
        })),
        data_source: "google_news",
      };
    });
  }
}
