import crypto from "crypto";
import { ClientConfig } from "../types/config";

// Demo API keys. In production these would be generated at contract time
// (PRD §9.1 Step 3) and only the hash stored server-side (§6.1).
export const DEMO_API_KEYS = {
  "solstice-sg": "mk_live_demo_solstice_" + "a".repeat(40),
  "northwire-apac": "mk_live_demo_northwire_" + "b".repeat(38),
  "acme-brand-sg": "mk_live_demo_acmebrand_" + "c".repeat(38),
  "orbit-whitelabel": "mk_live_demo_orbitwhite_" + "d".repeat(39),
};

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// Based directly on the Client Configuration Object sample in PRD §9.2,
// extended with the other three target clients from §1's table.
export const SAMPLE_CLIENTS: ClientConfig[] = [
  {
    client_id: "solstice-sg",
    client_name: "Solstice Media Group (SG)",
    feeds: [
      {
        feed_type: "atlas",
        schema_version: "1",
        cadence: "0 0 * * *", // daily at 00:00 UTC
        query_params: {
          platforms: ["facebook", "instagram", "tiktok", "linkedin"],
          region: ["sg", "ph"],
          language: ["en", "tl", "zh"],
        },
        delivery: {
          mechanism: "webhook",
          endpoint: "https://intel.solstice-example.com/api/messynet-feed",
          format: "json",
          hmac_enabled: true,
        },
      },
    ],
    auth: {
      api_key_id: "mk_live_abc123",
      api_key_hash: hashKey(DEMO_API_KEYS["solstice-sg"]),
      scopes: ["atlas:read"],
    },
    sla_tier: "enterprise",
    technical_contact: "integrations@solstice-example.com",
    contract_start: "2026-08-01",
    schema_locked_at: "2026-08-01",
  },
  {
    // §1 Target Clients: "Raw pipeline data drops for Northwire's internal
    // models" -> Pipeline Feed via Cloud Storage Drop, Parquet (§4.2).
    // Northwire scope is explicitly unresolved (open item B1) - this
    // config models the "raw Pipeline Feed" interpretation only.
    client_id: "northwire-apac",
    client_name: "Northwire Markets (APAC data partnership)",
    feeds: [
      {
        feed_type: "pipeline",
        schema_version: "1",
        cadence: "0 * * * *", // hourly rolling drop
        query_params: {
          platform: ["facebook", "instagram", "twitter", "reddit"],
          region: ["sg", "hk", "jp"],
        },
        delivery: {
          mechanism: "cloud_storage",
          provider: "gcs",
          bucket: "northwire-data",
          format: "parquet",
        },
      },
    ],
    auth: {
      api_key_id: "mk_live_def456",
      api_key_hash: hashKey(DEMO_API_KEYS["northwire-apac"]),
      scopes: ["pipeline:read"],
    },
    sla_tier: "enterprise_plus",
    technical_contact: "data-partnerships@northwire-example.com",
    contract_start: "2026-08-15",
    schema_locked_at: "2026-08-15",
  },
  {
    client_id: "acme-brand-sg",
    client_name: "Acme Insurance (direct brand client)",
    feeds: [
      {
        feed_type: "reputation",
        schema_version: "1",
        cadence: "0 6 * * *", // daily 06:00 UTC, per §3.3 recommended default
        query_params: { brands: ["Acme Insurance"] },
        delivery: {
          mechanism: "cloud_storage",
          provider: "s3",
          bucket: "acme-messynet-bi",
          format: "csv",
        },
      },
    ],
    auth: {
      api_key_id: "mk_live_ghi789",
      api_key_hash: hashKey(DEMO_API_KEYS["acme-brand-sg"]),
      scopes: ["reputation:read"],
    },
    sla_tier: "standard",
    technical_contact: "bi-team@acmeinsurance.example",
    contract_start: "2026-09-01",
    schema_locked_at: "2026-09-01",
  },
  {
    client_id: "orbit-whitelabel",
    client_name: "Orbit Platforms (white-label integrator)",
    feeds: [
      {
        feed_type: "composite",
        schema_version: "1",
        cadence: "0 1 * * *", // daily 01:00 UTC
        composite_components: ["atlas", "reputation"],
        composite_query_params: {
          atlas: { platforms: ["facebook", "instagram", "tiktok"], region: ["sg"] },
          reputation: { brands: ["Orbit Client Brand"] },
        },
        delivery: {
          mechanism: "webhook",
          endpoint: "https://platform.orbit-example.com/hooks/messynet",
          format: "json",
          hmac_enabled: true,
        },
      },
    ],
    auth: {
      api_key_id: "mk_live_jkl012",
      api_key_hash: hashKey(DEMO_API_KEYS["orbit-whitelabel"]),
      scopes: ["composite:read", "atlas:read", "reputation:read"],
    },
    sla_tier: "enterprise",
    technical_contact: "integrations@orbit-example.com",
    contract_start: "2026-09-15",
    schema_locked_at: "2026-09-15",
  },
];
