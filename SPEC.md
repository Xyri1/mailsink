# mailsink — SPEC.md

**Scope:** Cloudflare Worker (ingest + HTTP API) and its storage. The CLI is a separate spec in this repo; it consumes the contract defined here.
**Name:** `mailsink` is a working name. Rename freely; nothing below depends on it.

---

## 1. Purpose

A catch-all email sink for domains hosted on Cloudflare, built for **disposable per-service aliases**. Sign up anywhere with an invented address (`netflix-x7f2@example.com`) — no pre-registration. Inbound raw mail and versioned outbound structured JSON are durably archived in R2; D1 is the queryable index, provider-id/error, and per-recipient delivery-state store. Any authenticated agent can explicitly send from an active alias on an onboarded sending domain.

## 2. Goals

1. Receive mail to any address on configured domains via Email Routing catch-all.
2. Implicit alias lifecycle: an alias exists once it receives mail; aliases can be pre-blocked before first use.
3. Burn/block aliases: blocked aliases are rejected during the SMTP transaction (sender gets a bounce), zero storage.
4. Durable storage: raw RFC 5322 message is canonical and never lost, even when parsing fails.
5. Read path optimized for the dominant query — *"latest mail to alias X (from Y)"* — in one round trip.
6. Single-secret bearer auth suitable for a personal CLI.
7. Multi-domain support with one Worker deployment.
8. One store-then-forward destination per alias, configurable before first mail.
9. Send/reply through Cloudflare Email Sending with durable intent and lifecycle visibility.

## 3. Non-goals

Deferred to §13: full-text search, attachment extraction endpoints, webhooks/push notifications, retention/purge cron, web UI, multi-user auth, spam scoring. The CLI itself is out of scope here.

## 4. System overview

```
                        ┌────────────────────────────────────┐
  SMTP (port 25)        │  Worker: mailsink                  │
  ───────────────►      │                                    │
  Email Routing         │  email()  ── ingest pipeline ──►   │──► R2: raw .eml
  catch-all rule        │                                    │──► D1: emails, aliases
                        │  fetch()  ── /v1 JSON API   ◄──────│◄── CLI / agents (bearer token)
                        │       └── send binding ─────► Email Sending
                        └────────────────────────────────────┘
```

- **Explicit Email Routing rules win over catch-all.** Real addresses configured that way bypass mailsink. Mailsink routes are different: the catch-all still reaches the Worker, which stores and then forwards.
- **One Worker, N domains.** Each zone's Email Routing catch-all points at the same Worker. Domain is a first-class column everywhere.

### Repo layout (pnpm workspaces)

```
mailsink/
├── SPEC.md                  # this file
├── DECISIONS.md
├── package.json             # workspaces: ["packages/*"]
├── packages/
│   ├── shared/              # @mailsink/shared — API types + route constants only, zero logic
│   ├── worker/              # wrangler project: src/ingest.ts, src/api.ts, src/index.ts
│   └── cli/                 # Node CLI, built to dist/index.js, consumes the shared API contract
```

The Worker imports `@mailsink/shared` to type its responses; the CLI imports it to type its client. A contract change that isn't applied on both sides fails `tsc`, not production.

## 5. Ingest pipeline (`email()` handler)

Input: `ForwardableEmailMessage` — `message.from` (envelope MAIL FROM), `message.to` (envelope RCPT TO), `message.raw` (ReadableStream), `message.rawSize`.

1. **Normalize recipient.**
   - `domain` = RCPT TO domain, lowercased.
   - `local` = RCPT TO local part.
   - `alias` = `local.split('+')[0].toLowerCase()` — subaddress folding: blocking `x` also blocks `x+anything`.
   - `to_addr` stores the raw RCPT TO verbatim.
2. **Alias policy check.** `SELECT status, forward_to FROM aliases WHERE alias = ? AND domain = ?`.
   - If `blocked` and `BLOCK_MODE = "reject"` (default): `message.setReject("address unavailable")`, return. Sender receives a permanent failure; nothing is stored.
   - If `blocked` and `BLOCK_MODE = "drop"`: return without action. Local tests verify that the Worker takes no other action. *Caveat:* Cloudflare does not document the resulting SMTP behavior as a contract. Verify silent drop against a burner deployment before relying on it.
3. **Buffer the raw message.** Read `message.raw` fully into an `ArrayBuffer`. Inbound cap is 25 MiB vs 128 MB Worker memory; buffering beats stream-teeing in complexity and lets R2 write and parser share one copy.
4. **Write raw first.** `id = ulid()`; `r2_key = "{domain}/{alias}/{id}.eml"`; `RAW.put(r2_key, buffer)`. The `.eml` is canonical — once this succeeds, the mail cannot be lost by anything downstream.
5. **Parse** with `postal-mime`. Extract: header From (address + display name), subject, `Date:` header, text body, `has_html`, attachment count.
   - On parse failure: insert the row anyway with `parse_error = 1`, `from_addr` falling back to the envelope MAIL FROM, `subject`/`text_body` NULL. The `.eml` remains fully recoverable via `/raw`.
   - `text_body` is truncated to **65,536 characters**. HTML bodies and attachments are *not* stored in D1 — they live only in the `.eml`.
6. **Persist metadata** in one `DB.batch([...])` (implicit transaction):
   - `INSERT INTO emails (...)`, including the selected `forward_to`
   - `INSERT INTO aliases (...) ON CONFLICT(alias, domain) DO UPDATE SET last_seen_at = excluded.last_seen_at, email_count = email_count + 1`
7. **Forward after storage.** If the alias has `forward_to`, call `message.forward(forward_to)` only after the R2 put and D1 batch succeed. On an immediate failure, update the email row's `forward_error`; log and return even if that diagnostic update fails. The stored inbound message is not retried.
8. **Storage error semantics: fail loud.** Any primary R2/D1 storage failure throws out of the handler → Cloudflare signals a transient SMTP error → the sending server retries on its own schedule. The Worker never acks-and-drops. Known tradeoff: an R2 write that succeeds before a D1 failure leaves an orphaned `.eml` (the retry stores under a fresh ULID); orphans are harmless and removable later, and accepting them avoids two-phase-commit ceremony.
   - *Caveat:* the throw→transient-SMTP-error semantics are observed behavior, not documented contract — the Email Service docs do not specify the SMTP response for an unhandled handler exception. Verified empirically per §12 before relying on it. Deliberately **not** doing what Cloudflare's error-handling example does (catch + `setReject` fallback): `setReject` is a *permanent* failure and would convert transient storage errors into bounces, defeating the retry design.

### Reference pseudocode

```ts
async email(message, env) {
  const { alias, domain, toAddr } = normalize(message.to);
  const row = await env.DB.prepare(SEL_ALIAS).bind(alias, domain).first();
  if (row?.status === "blocked") {
    if (env.BLOCK_MODE !== "drop") message.setReject("address unavailable");
    return;
  }
  const buf = await new Response(message.raw).arrayBuffer();
  const id = ulid();
  const key = `${domain}/${alias}/${id}.eml`;
  await env.RAW.put(key, buf);
  const meta = await parseSafely(buf, message.from);   // never throws; sets parse_error
  await env.DB.batch([insertEmail({ ...meta, forwardTo: row?.forward_to }), upsertAlias(...)]);
  if (row?.forward_to) await forwardAndRecordFailure(message, row.forward_to, id, env);
}
```

## 6. Data model

### D1 (`migrations/0001_init.sql`)

```sql
CREATE TABLE aliases (
  alias          TEXT    NOT NULL,            -- normalized: lowercase, subaddress folded
  domain         TEXT    NOT NULL,            -- lowercase
  status         TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'blocked')),
  note           TEXT,                        -- e.g. "netflix trial 2026-06"
  forward_to     TEXT,                        -- verified store-then-forward destination
  first_seen_at  INTEGER NOT NULL,            -- unix ms
  last_seen_at   INTEGER NOT NULL,
  email_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (alias, domain)
);

CREATE TABLE emails (
  id               TEXT    PRIMARY KEY,       -- ULID: time-ordered, doubles as cursor
  alias            TEXT    NOT NULL,
  domain           TEXT    NOT NULL,
  to_addr          TEXT    NOT NULL,          -- raw envelope RCPT TO
  envelope_from    TEXT    NOT NULL,          -- raw envelope MAIL FROM (bounce path / forensics)
  from_addr        TEXT    NOT NULL,          -- header From; envelope fallback on parse_error
  from_name        TEXT,
  subject          TEXT,
  date_header      INTEGER,                   -- parsed Date: header, unix ms, nullable
  received_at      INTEGER NOT NULL,          -- ingest time, unix ms
  size_bytes       INTEGER NOT NULL,
  text_body        TEXT,                      -- ≤ 65,536 chars; full body always in .eml
  has_html         INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  parse_error      INTEGER NOT NULL DEFAULT 0,
  r2_key           TEXT    NOT NULL,
  forward_to       TEXT,                      -- route snapshot used for this message
  forward_error    TEXT                       -- immediate message.forward() failure
);

CREATE INDEX idx_emails_alias ON emails (alias, domain, id DESC);
```

Index notes: global listing and cursor pagination ride the `id` primary key (ULIDs sort by time). `since` is implemented as `id >= ulidFloor(since)` — the deterministic minimum ULID for a timestamp — so time filters also use the PK instead of a `received_at` index. The `from` substring filter is a `LIKE` scan; after the alias/domain predicate the partition is tiny, and even unpartitioned scans are fine at personal scale. No index can serve `LIKE '%x%'`, so none is pretended.

### R2

- Bucket: `mailsink-raw`. Key: `{domain}/{alias}/{ulid}.eml`, content type `message/rfc822`.
- Prefix-by-alias makes "nuke this alias's mail" a prefix list + batch delete, and catches orphans that D1 lost track of.
- Sent payload: `sent/{domain}/{alias}/{send-id}.json`, versioned structured JSON, retained permanently until an explicit sent purge/delete. Mailsink never generates or stores raw MIME.

### Outbound records

`sent_emails` indexes `id`, `alias`, `domain`, explicit `from_addr`, subject, recipients, R2 payload key, provider `message_id`/error, and timestamps. `sent_recipients` holds one row per recipient and its latest lifecycle state. The R2 payload is canonical; D1 deliberately does not duplicate payload content. Local validation failures create no rows. A valid request is archived in transient `submitting` state before its one synchronous provider attempt; a successful provider submission becomes `accepted`. Provider failures remain archived as `failed`, but the send command/API returns failure. There is no submission Queue or retry: reuse of the same send id returns the existing record; intentional resend requires a new id. If provider acceptance cannot be recorded in D1, the API returns the send id and an unknown-outcome error; that id will not resubmit, and the operator must inspect it rather than create a new id. Cloudflare may independently retry a downstream soft bounce.

## 7. HTTP API (`fetch()` handler)

- Base path `/v1`. JSON in/out (`application/json`), camelCase fields, except `/raw` which streams `message/rfc822`.
- **Auth:** `Authorization: Bearer <API_TOKEN>` on every route. Token lives in a Worker secret. Comparison is timing-safe: SHA-256 both values, `crypto.subtle.timingSafeEqual` the digests. Missing/wrong → `401`.
- **No CORS headers** — the only client is a CLI; browsers get nothing.
- Routing is hand-rolled (`URLPattern`/switch). No framework.
- No rate limiting (single trusted token holder).

### Error envelope

```json
{ "error": { "code": "unauthorized | bad_request | not_found | internal", "message": "..." } }
```

### Endpoints

**`GET /v1/emails`** — list, newest first (ordered by `id DESC`).

| Param | Type | Semantics |
|---|---|---|
| `alias` | string | exact match on normalized alias |
| `domain` | string | exact match, lowercase |
| `from` | string | case-insensitive **substring** over `from_addr` and `from_name` |
| `since` | int (unix ms) | `received_at >= since`, via `ulidFloor` |
| `limit` | int | default 20, max 100 |
| `cursor` | ULID | keyset: returns rows with `id < cursor` |
| `include` | `"body"` | inline `textBody` on each item |

Response: `{ "emails": EmailSummary[] | EmailWithBody[], "cursor": string | null }` — `cursor` is the last item's `id`, `null` when exhausted.

The canonical CLI read — *latest Netflix mail, one round trip*:

```
GET /v1/emails?alias=netflix-x7f2&domain=example.com&from=netflix&limit=1&include=body
```

**`GET /v1/emails/:id`** — full metadata + `textBody`. `404` if unknown.

**`GET /v1/emails/:id/raw`** — streams the `.eml` from R2. `Content-Type: message/rfc822`, `Content-Disposition: attachment; filename="{id}.eml"`. `404` if the row or object is missing.

**`DELETE /v1/emails/:id`** — deletes D1 row + R2 object. Response `{ "deleted": 1 }`. `404` if unknown.

**`DELETE /v1/emails?alias=&domain=`** — bulk purge; **both params required** (safety). Deletes R2 objects by prefix `{domain}/{alias}/` (batches of ≤1000), then D1 rows. Response `{ "deleted": n }` (D1 row count). Alias row and its status survive — purging mail does not unblock.

**`GET /v1/aliases`** — list aliases, ordered `last_seen_at DESC`.

| Param | Type | Semantics |
|---|---|---|
| `q` | string | case-insensitive substring on `alias` — powers CLI fuzzy resolution |
| `status` | `active \| blocked` | filter |
| `domain` | string | exact match |
| `routed` | `true` | only aliases with `forward_to` |
| `limit` | int | default 50, max 200; no cursor (personal scale) |

Response: `{ "aliases": AliasRecord[] }`.

**`PATCH /v1/aliases/:domain/:alias`** — body `{ "status"?: "active" | "blocked", "note"?: string | null, "forwardTo"?: string | null }`. **Upserts**: an unknown alias is created (`email_count = 0`) for explicit pre-blocking or pre-routing. `forwardTo: null` clears a route. Server normalizes the path alias (lowercases; rejects `+` with `400`) and validates a non-null destination as one email address. Response: the full `AliasRecord`.

**`GET /v1/sent`** — list sent records, newest first. Filters: exact normalized `alias`, `domain`, recipient `to`, and lifecycle `status`.

**`POST /v1/sent`** — body is a versioned structured JSON send request with id, a complete `from` address, recipients, subject, and text, HTML, and/or attachments. The sender domain must be onboarded for Email Sending. The CLI may expand a local `from` with its configured default domain before calling this endpoint. Sending creates an unseen alias but rejects a blocked one. The archive is transiently `submitting`; a successful provider response has `accepted` state and `messageId`. A provider failure is archived as `failed` but returns an API failure. Acceptance is not delivery.

**`GET /v1/sent/:id`** returns the record and per-recipient lifecycle; **`GET /v1/sent/:id/payload`** returns its archived JSON. **`DELETE /v1/sent/:id`** deletes one record/payload; **`DELETE /v1/sent?alias=&domain=`** purges one alias's sent archive. There is no automatic expiry.

**`POST /v1/emails/:id/reply`** derives the exact inbound `toAddr`, `from`, `reply-to`, and threading headers. It replies only to the chosen reply target unless `replyAll: true`; that enables reply-all. It quotes the original by default; `quote: false` suppresses it. It never copies original attachments. The CLI maps `--all` and `--no-quote` to those fields.

Delivery-event Queue consumers update `delivered`, `deferred`, `bounced`, `failed`, `rejected`, and `complained` per recipient. Unmatched events, including sends made through Gmail's Cloudflare SMTP handoff, are ignored.

Design intent: `(from, to)` is the human query path and both are **filters**, not keys — `from` because real senders are unguessable ESP addresses (substring match), `to` because aliases repeat over time (latest-wins via `limit=1`). ULIDs are plumbing: the CLI carries them between `list` → `raw`/`delete`; nobody types one.

## 8. Shared contract (`packages/shared`)

```ts
export interface EmailSummary {
  id: string;
  alias: string;
  domain: string;
  toAddr: string;
  envelopeFrom: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  dateHeader: number | null;
  receivedAt: number;
  sizeBytes: number;
  hasHtml: boolean;
  attachmentCount: number;
  parseError: boolean;
  forwardTo: string | null;
  forwardError: string | null;
}

export interface EmailWithBody extends EmailSummary {
  textBody: string | null;
}

export interface ListEmailsResponse {
  emails: EmailSummary[] | EmailWithBody[];
  cursor: string | null;
}

export interface AliasRecord {
  alias: string;
  domain: string;
  status: "active" | "blocked";
  note: string | null;
  forwardTo: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  emailCount: number;
}

export interface ListAliasesResponse { aliases: AliasRecord[]; }
export interface DeleteResponse { deleted: number; }

export type ApiErrorCode = "unauthorized" | "bad_request" | "not_found" | "internal";
export interface ApiError { error: { code: ApiErrorCode; message: string }; }

export const ROUTES = {
  emails: "/v1/emails",
  email: (id: string) => `/v1/emails/${id}`,
  emailRaw: (id: string) => `/v1/emails/${id}/raw`,
  reply: (id: string) => `/v1/emails/${id}/reply`,
  sent: "/v1/sent",
  sentEmail: (id: string) => `/v1/sent/${id}`,
  sentPayload: (id: string) => `/v1/sent/${id}/payload`,
  aliases: "/v1/aliases",
  alias: (domain: string, alias: string) => `/v1/aliases/${domain}/${alias}`,
} as const;
```

DB columns are snake_case; the Worker maps to camelCase at the API boundary. `@mailsink/shared` contains types and route constants only — no runtime logic.

## 9. Configuration & deployment

Copy `packages/worker/wrangler.toml.example` to the ignored
`packages/worker/wrangler.toml` file:

```toml
name = "mailsink"
main = "src/index.ts"
compatibility_date = "2026-07-29"
workers_dev = true

[vars]
BLOCK_MODE = "reject"                    # "reject" (bounce) | "drop" (silent)

[[d1_databases]]
binding = "DB"
database_name = "mailsink"
database_id = "<set after `wrangler d1 create`>"

[[r2_buckets]]
binding = "RAW"
bucket_name = "mailsink-raw"

[[send_email]]
name = "EMAIL"

[[queues.consumers]]
queue = "mailsink-email-events"
```

Create `mailsink-email-events` with `wrangler queues create mailsink-email-events` before the first deploy, because the Worker config declares it as a consumer. Secrets: `wrangler secret put API_TOKEN` (generate ≥32 random bytes; rotate by re-putting). Dependencies: `postal-mime`, a maintained ULID impl (e.g. `ulidx`). Migrations via `wrangler d1 migrations apply`.

`mailsink setup sending [domain]` uses the default domain when omitted. After confirmation it creates or verifies `mailsink-email-events`; it never deploys or sends a test message. Domain onboarding/DNS verification, domain event subscription, Worker Queue binding, deploy, and live send remain explicit human steps.

## 10. Cloudflare setup (per domain)

Email Routing now lives under the **Email Service** product; all dashboard paths are account-level: **Compute → Email Service → Email Routing**.

0. Deploy the Worker first (`wrangler deploy`) — the catch-all action dropdown only lists already-deployed Workers.
1. **Email Routing → Onboard Domain** (Cloudflare installs MX + SPF + DKIM (`cf2024-1._domainkey`) DNS records automatically and **locks** them — unlock via Email Routing settings before any manual DNS edits. MX is exclusive — no other inbound mail provider on the same apex).
2. Keep/add explicit routing rules for real addresses (they take precedence over catch-all).
3. **Routing Rules** → Catch-all rule → Active, action **Send to a Worker** → `mailsink`.
4. Repeat per additional domain; same Worker.

The catch-all Worker action itself needs no destination verification. `mailsink route` checks the destination on the active Wrangler Cloudflare account and requests verification when it is missing; it saves the alias mapping only after Cloudflare reports the destination verified.

Notes:
- **Subaddressing toggle (Email Routing → Settings):** The Worker's `+` folding (§5.1) works in either state when the message reaches the catch-all. When the toggle is on, `realuser+foo@` matches the explicit `realuser@` rule and can bypass the sink. Leave it off if `+` variants of explicit addresses must reach the catch-all. Turn it on if those variants must follow the explicit rule.
- **Renaming the Worker severs its binding to the catch-all rule** — re-select the Worker in each domain's catch-all rule after a rename.

### Sending setup

Sending domains are onboarded separately from Email Routing. In **Compute > Email Service > Email Sending**, follow [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) to onboard the domain and verify its DNS records. Select the Queue and create the domain event subscription on its **Subscriptions** tab. The Worker configuration declares the Queue consumer. Deploy the Worker after these resources are ready. Wrangler 4.115.0 cannot create an `email.sending` subscription because the command has no Email Sending source or domain option. Use the dashboard or REST API. Never replace an existing DMARC record; use `p=none` during validation. Leave Email preview enabled at first. Cloudflare retains previews for about seven days. The user must confirm before deployment or any live send.

## 11. Operational limits & cost

- Inbound message cap: **25 MiB** (Email Routing). Larger mail is rejected upstream of the Worker.
- **Workers Free plan CPU** can be exceeded while parsing a very large MIME message. Cloudflare records this failure as `EXCEEDED_CPU`. Cloudflare does not document the SMTP result as a contract. Use the Workers Paid plan if this limit affects real messages.
- Inbound storage can fit free tiers. Email Sending is [public beta](https://developers.cloudflare.com/email-service/get-started/send-emails/): arbitrary-recipient sending needs Workers Paid, includes 3,000 messages/month, then costs $0.35/1,000. Daily quotas are adaptive.
- Cloudflare Email Sending limits: 50 recipients per message, 998 subject characters, 5 MiB for arbitrary recipients, 25 MiB for verified destination addresses, and 16 KB of custom headers. Mailsink also limits a send to 32 attachments.
- `messageId` means Cloudflare accepted/queued the send, not delivered or received. A live gate is: R2/D1 archive, provider id, terminal Queue event, CLI status, mailbox receipt, and SPF/DKIM/DMARC results.
- **Upstream filtering:** before rule matching, Cloudflare rejects mail that fails the sender's DMARC policy and mail from RBL-listed IPs. The sink never sees that traffic (fine — it's spam suppression for free), and any end-to-end test mail must come from a DMARC-passing sender or it dies before the Worker runs.
- Privacy note: `BLOCK_MODE=reject` confirms an address exists-but-refuses; with a catch-all, every address "exists" anyway, so the leak is nil. `drop` is available if you'd rather spammers see success.

## 12. Testing

- **Deterministic:** `pnpm test` runs fake-binding fault tests, Worker tests in the Cloudflare Vitest pool, and a local Wrangler email smoke test. The integration tests apply the real D1 migrations and use local D1, R2, Queue, and Email bindings. They cover all six delivery events, duplicate and older events, R2 list pagination, local RFC 5322 inbound handling, and local outbound text and HTML output.
- **Local manual:** `wrangler dev` exposes a local email injection endpoint. Run this command from the repository root:

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=noreply@em.netflix.com&to=netflix-x7f2@example.com" \
  -H "Content-Type: message/rfc822" \
  --data-binary @packages/worker/test/fixtures/plain.eml
```

- **Live failure gate:** use a burner deployment before relying on the failure semantics in §5. Confirm that a thrown storage error causes a transient SMTP result, returning without action silently drops the message, and `setReject` causes a permanent SMTP result.
- **Outbound local/remote:** the local Email Sending binding simulates; `remote=true` sends real mail. Never use the latter without confirmation. Verify provider acceptance, per-recipient Queue terminal events, CLI state, and mailbox/authentication separately.
- See [the Cloudflare Email Service test strategy](docs/cloudflare-email-service-testing.md) for completed and remaining coverage. See [Cloudflare platform limitations](docs/LIMITATIONS.md) for platform boundaries.

## 13. Deferred features

- Retention cron (scheduled handler purging old mail / orphaned R2 objects).
- Full-text search (D1 FTS5) if `LIKE` ever feels slow.
- Attachment extraction endpoint (parse on read from `.eml`).
- Push (webhook/Telegram) on arrival for watched aliases.
