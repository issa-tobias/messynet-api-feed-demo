# MessyNet API Feed — Three-Persona Stress Test Report

**Date:** 2026-07-19 · **Target:** Demo Console (`npm run demo:console`) — real Feed Engine + REST API + browser dashboard
**Method:** Simulated three user personas against the running system. Every bug found was fixed the same session and re-tested to green. Fix commits touch both backend (`src/`) and frontend (`public/`).

## Personas & coverage

| Persona | Surface | Scenarios run |
|---|---|---|
| Business leader | Browser dashboard | Trigger runs per client, switch clients mid-run, rapid re-clicks, theme toggle, run log review, mobile + tablet viewports |
| Data analyst | Delta Polling API | Cursor pagination (repeat + follow-up pages), limit edge values (`0`, `-5`, `abc`, `999999`), `since` edge cases (future, >30-day lookback, malformed, missing), filter validation, cross-page data consistency, brand scoping |
| Tech / IT staff | Full API via curl | Auth (missing/malformed/empty Bearer, wrong scheme), rate limits + `Retry-After`, wrong HTTP methods, unknown routes/feed types, path traversal on file preview, malformed JSON bodies, cursor tampering, webhook header contract vs PRD §6.1 |

## Results summary

**7 bugs found, 7 fixed, 0 outstanding.** 12 additional probes passed with no issue found.

| # | Found by | Severity | Bug | Fix |
|---|---|---|---|---|
| 1 | IT (T14) | **High — contract** | `X-MessyNet-Key` webhook header sent a hardcoded placeholder (`mk_live_demo_key`) instead of the client's scoped API key required by PRD §6.1 | Delivery Agent now takes the key from the credentials provider (`WebhookSecretProvider.getApiKey`), which stands in for a secrets-manager lookup — config still stores only the key hash (`deliveryAgent.ts`, `feedEngine.ts`, `webhookSecrets.ts`) |
| 2 | IT (T9) | **High — security** | Malformed JSON body returned Express's default HTML error page **including a stack trace with server file paths** | JSON error handler: 400 with generic message for syntax errors, 500s logged server-side only (`server.ts`, wired in `index.ts` + `demoServer.ts`) |
| 3 | Analyst (A9) | Medium — data integrity | Identical delta queries returned different `post_id`s each call (unseeded `crypto.randomBytes` in the mock), breaking pagination consistency and client-side dedup | All mock identifiers now derive from the seeded RNG (`rng.hex()`); synthesized delta run_ids are content-hashed so re-fetching a window yields stable ids (`mockDataSource.ts`, `deltaFeed.ts`). Verified: repeat query → identical ids; page 1 ∩ page 2 = ∅ |
| 4 | Analyst (A2) | Medium — API contract | `limit=-5` returned an empty page with `has_more: true` and a negative-offset cursor; `limit=abc`/`0` silently coerced to default | `limit` must be a positive integer when provided → 400 otherwise (`deltaFeed.ts`) |
| 5 | Analyst (A8) | Medium — API contract | Unknown `platform` filter values (e.g. `myspace`) were accepted and the mock **fabricated records with invalid platform values**, violating the §3.1 enum | Platform values validated against the contract enum → 400 listing valid values (`deltaFeed.ts`) |
| 6 | Analyst (A10) | Medium — correctness | Reputation delta without `?brand=` scored a placeholder "Default Brand" instead of the client's contracted brands | Defaults to the brands in the client's reputation (or composite) feed config; 400 if none configured and none passed (`deltaFeed.ts`) |
| 7 | Business (UI) | Medium — UX correctness | Switching clients while a run was animating overlaid the old client's stepper/receipt on the new client's card (Northwire card showing the agency client's webhook receipt) | Run-token guard: client switches invalidate in-flight runs' UI updates; stepper/receipt reset on switch; run still completes server-side and lands in the shared run log (`public/app.js`) |

**Lower-severity fixes bundled in:**

| # | Found by | Bug | Fix |
|---|---|---|---|
| 8 | IT (T5) | Wrong-method/unknown routes returned HTML (`Cannot POST /v2/feed/atlas`) instead of JSON | JSON 404 for all `/v2/*` and unmatched demo routes (`server.ts`) |
| 9 | IT (T6) | Unknown feed type returned a misleading 403 ("not scoped for telegram:read") because scope-check ran before existence-check | Feed-type validation now precedes scope middleware → clean 404 (`deltaFeed.ts`) |
| 10 | Business (mobile) | Feed Engine stepper clipped on mobile — only 3 of 5 pipeline stages visible, unreachable | `overflow-x: auto` on the stepper (`style.css`) |
| 11 | Business (mobile) | Webhook receipt header block overflowed its card on narrow viewports | `overflow-x: auto` on `.receipt-headers` (`style.css`) |

## Probes that passed (no bug)

- Auth: missing header, `Basic` scheme, empty Bearer, invalid key → all 401; cross-scope access → 403
- Rate limiting: exactly 30/min pass on Standard tier, then 429 **with `Retry-After`**; run-log limit separate (60/hr)
- Path traversal on `/demo/drops/preview` (`../`, absolute paths) → rejected
- Cursor tampering (garbage base64) → safe fallback to first page
- `since` beyond 30-day lookback → 400 with clear message; future `since` → empty result; malformed → 400
- `limit` above tier cap → silently capped to tier maximum (2,000 enterprise) per §8
- Trigger endpoint: unknown client / out-of-range feed index → 404 JSON
- HMAC signature verification on every webhook delivery → valid
- Theme persistence across reloads; tablet layout; page-level horizontal scroll (none)

## Retest evidence

All 7 fixes re-tested green in one pass after the fix batch (see terminal transcript):
`T5→JSON 404 · T6→404 · T9→JSON 400 no trace · T14→real client key · A2/A2b→400 · A8→400 with enum · A9→stable ids, disjoint pages · A10→"Acme Insurance" · regressions: 200/200/401/403/400 all correct · full CLI demo suite passes end-to-end`

## Known limitations (by design, not bugs — flagged for the PRD's open items)

- **Webhook payload size limits (§8) are not enforced** — split-vs-compress behavior is undecided (open item C11, CTO). Delivery currently proceeds regardless of size.
- **Key rotation (§6.1, 72 h grace)** — constant defined, no rotation endpoint; onboarding-time feature, not in demo scope.
- **Delta cursor is offset-based** over a deterministic snapshot — fine for the mock; a real MongoDB implementation should use a timestamp/`_id` keyset cursor (relates to open item J3).
- Rate-limit counters are in-memory per process; multi-instance deployment needs a shared store (Redis) — deployment topology is open item C1.
