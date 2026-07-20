# MessyNet API Feed

Reference implementation of the Feed Engine defined in `MessyNet_API_Feed_PRD.docx` (v0.9). Implements all four feed types (Pipeline, Atlas, Reputation, Composite), all three v1 delivery mechanisms (Webhook POST, Cloud Storage Drop, Delta Polling), HMAC signing, exponential-backoff retry with dead-letter queue, the Run Log endpoint, and tiered auth/rate limiting — against a mock data layer, since this workspace has no connection to the real MongoDB/Atlas/MessyRep stack.

## Setup

```bash
npm install
npm run typecheck   # or: npm run build
```

Requires Node 20+.

> **Note:** All client names, API keys, webhook secrets, and data in this repository are fictional demo values. The data layer is fully synthetic — nothing here connects to or contains real customer or platform data.

## Run the end-to-end demo

```bash
npm run demo
```

Exercises the whole system with no external dependencies: spins up a local receiver that mimics a client endpoint (verifying HMAC signatures per PRD §6.2), runs one feed of each type, writes real files under `.data-drops/` (including an actual Parquet file, read back to prove round-trip correctness), then hits the Delta Polling and Run Log REST endpoints — including the 401/403/400 failure paths for bad key, wrong scope, and missing params.

## Client demo dashboard

```bash
npm run demo:console
```

Starts a live, clickable dashboard at `http://localhost:4200` — the real Feed Engine and REST API running in-process, with a static frontend (`public/`) on top. Two views, toggled in the header:

**Client view** (default — for business/prospect audiences): a branded BI dashboard per client (Solstice Intelligence for the agency client, Social Signal Intake for the market-data partner, Brand Health for Acme, the Orbit white-label suite) that **fills itself as feeds arrive** — KPI tiles, sentiment/platform/community charts, score trends, article lists, all computed from what was actually delivered (webhook payloads, CSV and Parquet drop files parsed back). Turn on **Auto-deliver** and feeds arrive on their own every 12 s — the push model demonstrating itself. A Pull-vs-Push panel (§2.2) contrasts the polling script a client would otherwise maintain with the one-time feed config, including a live counter of deliveries received while the page has been open.

**Technical view** (for engineering/IT audiences): the original console — feed config, the pipeline stepper (Scheduler → Extractor → Formatter → Delivery Agent → Run Logger), the signed webhook receipt with HMAC verification or the drop-file preview, the Run Log table, a **Dead-letter Queue** card, and the Delta Polling Playground with one-click 401/403/400 failure demos.

The **Simulate client outage** toggle makes the webhook endpoint return 503, driving the real §7.2 path live: watch the Delivery Agent back off through 5 attempts (compressed to ~35 s from the production 8.5 h schedule), land in the dead-letter queue with an alert, then restore the endpoint and click **Re-deliver** to recover the retained payload — the full §7.2 story including manual re-delivery.

Nothing in either view is mocked at the UI layer; only the underlying data source is.

**Brand identities:** the console ships in two visual identities sharing the same JS — the neutral console at `/` and a **Ground Truth** version at `/groundtruth.html` styled per the MessyNet Brand Book 2026 Route Two (Deep Palm / Capiz / Marigold / Chili / Buri palette, Fraunces + Albert Sans, the strand mark, warm-light-first with a Deep Palm "evening" dark variant; Marigold is reserved for the signal — the trend line, the delivery moment). Switch between them with the header link on either page. Fonts load from Google Fonts with serif/sans fallbacks when offline.

## Run the service

```bash
npm run build && npm start   # or: npm run dev
```

Starts the Scheduler (cron-triggers push deliveries per client config) and the REST API (`GET /v2/feed/:feedType`, `GET /v2/feed/runs`) on `PORT` (default 4000).

## Layout

```
src/types/            Feed payload + client config types (PRD §3, §5, §9.2)
src/config/            Schema version registry, rate limits, retry schedule, sample clients (PRD §5.2, §7.2, §8, §9.2)
src/data/               DataSource interface + mock implementation
src/engine/             Extractor, Formatter, Delivery Agent, Run Logger, Scheduler, Feed Engine orchestrator (PRD §2.3)
src/api/                Auth, rate-limit middleware, Delta Polling + Run Log routes (PRD §4.3, §6.1, §7.4, §8)
src/demo/               Webhook receiver, CLI demo script, and the demo console server
public/                 Static frontend for the demo console (index.html, style.css, app.js)
```

## Swapping in real data

Everything upstream of `src/data/dataSource.ts` is generic. To connect the real stack, implement `DataSource` against MongoDB (pipeline), Atlas, and MessyRep, and pass it into `FeedEngine`/`Scheduler` in `src/index.ts` instead of `MockDataSource`. Nothing else changes.

## Assumptions encoded from the PRD's open items

The PRD flags ~30 decisions as pending CEO/CTO/Engineering sign-off (§11). Business/commercial ones (pricing, SLA tiers, add-on positioning, Northwire scope) are out of scope for code and left alone. Where a *technical* default was needed to make something runnable, this build uses the PRD's own "Recommended" answer, each traceable by comment to the relevant section:

- 5-attempt exponential backoff exactly as tabled in §7.2 (`src/config/constants.ts`)
- HMAC-SHA256 signing implemented and wired to `hmac_enabled` per client (§6.2)
- Telegram and keyword/hashtag filtering excluded from Pipeline Feed (§3.1, open items C13/C10)
- Composite Feed: fail-and-retry the full payload if any component fails extraction, never partial delivery (§3.4, C7)
- Atlas narrative field: always present, `null` when a community isn't in the top 5 by connectivity, rather than omitted (§3.2, C9)
- Parquet: a working serializer is wired in (`parquetjs-lite`), answering open item C8/J2's factual question ("does one exist") — whether it *ships* in v1 is still the CTO's scope call
- Rate limits and lookback window use the exact placeholder figures from §8/§4.3, isolated in one config file for a one-line swap once the infrastructure stress test lands

## Fixes applied vs. the PRD text

Found while implementing — none change product direction, all are either bugs or gaps needed to make the spec buildable:

- §5.5 sample payload had `"score_delta": +0.031`, which is invalid JSON (leading `+`). Emit a plain signed number instead.
- Webhook header (`X-MessyNet-Feed: atlas-v1`) and payload body (`"schema_version": "1"`) used inconsistent version formats for the same concept. Standardized on the `{feed_type}-v1` form from §5.2's registry everywhere.
- Composite Feed (§3.4) had no baseline schema, leaving §5.1's schema-stability commitments with nothing to attach to for that feed type. Added a minimal stable envelope (`{feed_type, schema_version, components, component_status}`) — component contents remain each component's own versioned schema.
- Composite feed configs need per-component filters (Atlas needs `platforms`/`region`, Reputation needs `brands` — they can't share one `query_params` shape). Added `composite_query_params` to the client config type.
- (Demo console) Mounting the webhook receiver sub-app at the broad `/demo` prefix let its catch-all body-parser intercept every sibling `/demo/*` route — body-parser's double-parse guard then silently skipped JSON parsing on `/demo/trigger`, leaving `req.body` as unparsed text. Fixed by mounting the receiver at its exact inbox path only (`src/demo/demoServer.ts`).
