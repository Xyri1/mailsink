# mailsink — DECISIONS.md

## D-001 — Worker-owned REST API, not direct Cloudflare API access

**Context.** The only reader is a CLI. It could query D1/R2 through Cloudflare's own APIs, or through an API the Worker exposes.
**Decision.** The Worker exposes a `/v1` JSON API; mail data and alias configuration go through it. The `route` control flow may also call Wrangler to verify a Cloudflare destination address, but never reads D1 or R2 directly.
**Rejected.** (B) Ingest-only Worker + CLI → D1 HTTP API + R2 keys: puts a Cloudflare account token and R2 credentials on every CLI machine, couples the CLI to the SQL schema, and the Worker needs D1 for the blocklist anyway — coupling kept, little code saved. (C) Queue pipeline: retries/burst capacity irrelevant at personal volume; requires Workers Paid.
**Consequences.** ~6 routes of Worker code; one revocable bearer secret on client machines; schema stays private to the Worker; the same API can later serve agents or a UI.

## D-002 — Monorepo, pnpm workspaces, anemic shared package

**Context.** "Two specs" raised the question of two repos.
**Decision.** One repo: `packages/shared` (API types + route constants, zero logic), `packages/worker`, `packages/cli`. Worker and CLI both import `@mailsink/shared`.
**Rejected.** Two repos (contract drift, or a third published types package as ceremony); single package with dual build targets (workerd vs Node runtimes want separate tsconfigs/deps anyway).
**Consequences.** Contract changes fail `tsc` on whichever side was not updated. Atomic commits keep the Worker and CLI synchronized.

## D-003 — R2 raw `.eml` canonical + D1 metadata

**Context.** Cloudflare's docs example stores via KV + Queues; metadata-only storage was also on the table.
**Decision.** Raw RFC 5322 message in R2 (`{domain}/{alias}/{ulid}.eml`) is the source of truth; D1 holds queryable metadata + truncated text.
**Rejected.** KV (no relational queries, 25 MiB values awkward); D1-only with blob/text bodies (row-size pressure, attachments don't belong in SQLite); parse-only storage (lossy — unparseable or mis-parsed mail would be unrecoverable).
**Consequences.** Any future feature (attachment extraction, re-parse with a better parser, HTML view) is recoverable from the `.eml`. Alias-prefixed keys make bulk purge a prefix delete.

## D-004 — Blocked alias = SMTP-time reject (bounce); silent drop as config

**Context.** "Burning" a leaked alias is the defining feature for disposable aliases.
**Decision.** `setReject("address unavailable")` during the SMTP transaction; nothing stored. `BLOCK_MODE=drop` flips to silent drop (return without action).
**Rejected.** Store-but-hide (still accumulates junk, costs storage, sender keeps a working address); drop as default (lying to legitimate senders by default felt wrong; bounces also get spam lists to prune).
**Consequences.** Sender sees a permanent failure. Reject confirms exists-but-refuses, but under a catch-all every address "exists," so the information leak is nil.

## D-005 — Alias normalization: lowercase + subaddress folding

**Decision.** `alias = localPart.split('+')[0].toLowerCase()`; raw RCPT TO preserved in `to_addr`. PATCH rejects `+` in the alias path param.
**Rejected.** Treating `x+tag` as distinct aliases — would let spammers sidestep a block by appending tags, and splits one service's mail across rows.
**Consequences.** Blocking `x` blocks `x+anything`. Tag information isn't lost (lives in `to_addr` and the `.eml`).

## D-006 — Buffer `message.raw`, don't stream-tee

**Context.** R2 write and postal-mime both need the bytes.
**Decision.** Read the stream once into an `ArrayBuffer`, share it.
**Rejected.** `tee()` + parallel consumption: more failure modes, no benefit when inbound is capped at 25 MiB against 128 MB Worker memory.
**Consequences.** Trivial control flow. Memory ceiling is bounded by Email Routing's own cap.

## D-007 — Store raw before parsing; parse failure is a flagged row, not an error

**Decision.** R2 `put` precedes parsing. Parse failure → `parse_error=1`, `from_addr` falls back to envelope MAIL FROM, body fields NULL. Both envelope MAIL FROM and header From are stored (`envelope_from`, `from_addr`).
**Rejected.** Parse-then-store (a parser bug could lose mail); dropping unparseable mail.
**Consequences.** The pipeline can never lose a message it accepted. Forensics on spam (bounce-path vs display sender) comes free.

## D-008 — Read pattern: `(from, to)` are filters, latest-wins; IDs are plumbing

**Context.** Proposed fetch-by-`(from, to)` as the access pattern.
**Decision.** `to` (alias) is an exact filter; `from` is a case-insensitive substring over `from_addr` + `from_name`; "the" email is `limit=1` newest-first with `include=body` — one round trip. ULIDs remain the canonical key for `raw`/`delete`/cursors. Fuzzy alias resolution (`?q=`) lives in the CLI via `GET /aliases`, keeping the API primitive.
**Rejected.** `(from, to)` as a key — not unique over time (welcome/verify/receipts to one alias) and `from` is unguessable a priori (ESP senders like `no-reply@em1234.netflix.com`), so equality lookup fails the moment it matters.
**Consequences.** `GET /v1/emails?alias=…&from=netflix&limit=1&include=body` answers the dominant query. Nobody ever types a ULID.

## D-009 — ULID identifiers

**Decision.** ULIDs for email ids; also embedded in R2 keys.
**Rejected.** UUIDv4 (no time ordering → needs a separate sort/cursor column); auto-increment (D1 round trip to learn the id, leaks volume).
**Consequences.** `ORDER BY id DESC` is newest-first; keyset pagination and `since` (via `ulidFloor(ts)`) ride the primary key; no `received_at` index needed.

## D-010 — `text_body` ≤ 65,536 chars in D1; HTML/attachments only in `.eml`

**Decision.** Store extracted plain text, truncated at 64K characters. HTML and attachments are never written to D1.
**Rejected.** Full bodies in D1 (row-size pressure for no current benefit); storing nothing (forces a `.eml` fetch+parse for every `show`).
**Consequences.** Sign-up mail (KBs) is always complete; `include=body` stays cheap (worst case 64 KB × limit). Full fidelity one `/raw` call away.

## D-011 — Auth: single static bearer secret; no CORS; no rate limiting

**Decision.** One `API_TOKEN` Worker secret; timing-safe compare via SHA-256-then-`timingSafeEqual`; no CORS headers; no rate limits.
**Rejected.** Cloudflare Access / mTLS / per-device tokens — ceremony with one trusted client; API keys in D1 — state for no gain.
**Consequences.** Rotation = `wrangler secret put` + update CLI config. Browsers can't call the API at all. Revisit only if a second consumer appears.

## D-012 — Implicit alias creation; pre-block via PATCH upsert

**Decision.** Aliases come into existence on first received mail (ingest upsert). `PATCH /v1/aliases/:domain/:alias` upserts, so an alias can be blocked before it ever receives mail.
**Rejected.** Registration-first (kills the core UX: inventing an address at a signup form with zero prior steps).
**Consequences.** Zero-friction signups; the upsert doubles as the pre-block mechanism; `note` gives aliases provenance.

## D-013 — Failure semantics: throw → SMTP transient retry; orphaned R2 objects accepted

**Decision.** Any storage failure throws out of `email()`; the sender's MTA retries. A successful R2 write followed by a D1 failure leaves an orphan `.eml` (the retry stores under a fresh ULID).
**Rejected.** Swallow-and-drop (silent mail loss); compensating R2 delete on D1 failure (the delete can also fail — recursion of the same problem); two-phase patterns (ceremony, still imperfect).
**Consequences.** Mail is never lost while appearing delivered. Orphans are inert, prefix-discoverable, and a future cron can remove them.

## D-014 — No HTTP framework

**Decision.** Hand-rolled routing (`URLPattern`/switch) for ~6 routes.
**Rejected.** Hono — fine tool, but a dependency for routing this small contradicts the YAGNI posture.
**Consequences.** Zero framework lock-in; revisit if the route count meaningfully grows (it shouldn't — see D-015).

## D-015 — Initial scope cuts (YAGNI ledger)

Deferred, with the trigger that would justify each:

- **Retention/orphan-sweep cron** — trigger: measurable junk accumulation.
- **FTS5 search** — trigger: `LIKE` within alias partitions ever feels slow (it won't at personal scale).
- **Attachment extraction endpoint** — trigger: first real need to pull an attachment via CLI.
- **Push notifications (webhook/Telegram)** — trigger: a watched-alias use case appears.
- **Web UI / multi-user** — trigger: a second human user, which is a different product.

## D-016 — CLI uses task verbs and OS credential storage

**Context.** The CLI needed to make common disposable-alias workflows fast without making users type full aliases and ULIDs.
**Decision.** `packages/cli` is a Node/Commander client for the Worker `/v1` API, built with esbuild to `dist/index.js`. It stores only URL/default-domain config on disk, stores the API token via `@napi-rs/keyring`, supports `MAILSINK_URL`/`MAILSINK_TOKEN` for scripts, and exposes task verbs including `send`, `reply`, `ls inbox`, `ls sent`, and `payload`. Wrangler owns Cloudflare login, Worker-secret upload, and route-destination verification; mailsink adds no Cloudflare SDK or account-token storage.
**Rejected.** A schema-coupled D1/R2 client; plaintext token config; a low-level endpoint-shaped CLI.
**Consequences.** The common flow is `mailsink latest netflix --from netflix`; fuzzy alias resolution stays client-side over `GET /v1/aliases`, read commands may fan out, and write commands require an unambiguous alias. Development uses pnpm scripts, and installed CLI commands run through Node.

## D-017 — Per-alias routing is store-then-forward

**Context.** A Cloudflare Email Routing rule for `support@example.com` would win before the catch-all Worker, so mailsink could forward the message but could not store it.
**Decision.** Keep the Cloudflare catch-all pointed at mailsink. Store the raw message and metadata first, then call `message.forward()` when the alias has one configured `forward_to`. A destination is saved only after Wrangler reports it verified. Immediate forwarding failures are recorded on the email row and do not throw or retry inbound delivery.
**Rejected.** Creating literal Cloudflare custom routing rules (bypasses storage); forwarding before storage (can lose the archive); a retry queue (requires more infrastructure and changes at-least-once behavior).
**Consequences.** `mailsink route` can list a preconfigured alias before its first message. A stored message may have `forwardError`; a successful `forward()` means Cloudflare accepted the forward, not that the destination mailbox delivered it.

## D-018 — Archive structured sends; do not retry submission

**Decision.** Archive a versioned structured JSON payload permanently in R2 and a searchable/provider/lifecycle index in D1 before one synchronous Email Sending attempt. Start transiently at `submitting`, then become `accepted` on provider success; never generate raw MIME, enqueue submission, or retry it. A repeated send id returns the existing record; a deliberate resend gets a new id. Local validation failures are unarchived; provider failures are archived as `failed` and returned as failures.
**Consequences.** Intent and failure are durable without duplicate mail from retries. Cloudflare's accepted `messageId` and downstream retry behavior remain distinct from delivery. Email Sending and D1 cannot commit atomically: if recording acceptance fails, the API reports the send id as an unknown outcome and that id remains non-resubmittable.

## D-019 — Explicit identities and event-driven delivery state

**Decision.** Every send declares `from`. The CLI expands local parts with its default domain; the Worker API requires full addresses on onboarded sending domains. Unseen aliases are created; blocked aliases cannot send. A Queue subscription updates recipient lifecycle; unmatched events are ignored.
**Consequences.** Any bearer-token holder can send to any address, with no custom rate limit. `accepted`, `delivered`, and mailbox receipt are separate states.

## D-020 — Gmail is an SMTP handoff, not a mailsink send

**Decision.** `route` remains inbound-only. `provider gmail` prints Cloudflare SMTP “Send mail as” settings (`smtp.mx.cloudflare.net`, 465, implicit TLS, `api_token`, alias address) and requires a human-managed Email Sending:Edit token, which it never receives.
**Consequences.** Gmail-originated messages bypass the mailsink sent archive and are not matched to delivery events.
