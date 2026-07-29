# mailsink

A catch-all email sink for domains on Cloudflare, built for **disposable per-service aliases**. It receives, archives, forwards, and sends mail through the same authenticated Worker.

Sign up anywhere with an invented address — `netflix-x7f2@example.com` — with no pre-registration. Inbound mail is stored durably and read through a small authenticated JSON API. Route useful aliases to a verified inbox after storage, or **burn** leaked aliases so future mail is rejected.

```
                        ┌────────────────────────────────────┐
  SMTP (port 25)        │  Worker: mailsink                  │
  ───────────────►      │                                    │
  Email Routing         │  email()  ── ingest pipeline ──►   │──► R2: raw .eml
  catch-all rule        │                                    │──► D1: emails, aliases
                        │  fetch()  ── /v1 JSON API   ◄──────│◄── CLI / agents (bearer token)
                        │  send_email() ──────────────► Cloudflare Email Sending
                        └────────────────────────────────────┘
```

## How it works

- **Implicit aliases.** An alias exists the moment it receives mail. No registration step.
- **Burning.** `PATCH /v1/aliases/:domain/:alias` with `{"status": "blocked"}` makes future mail bounce at SMTP time (or drop silently with `BLOCK_MODE=drop`). Upserts, so you can pre-block an alias before it's ever used.
- **Durable storage.** The raw RFC 5322 message in R2 is canonical — written before parsing, never lost even when parsing fails. D1 holds queryable metadata and a truncated text body.
- **Store-then-forward routes.** Set one verified destination per alias. Mailsink stores the message first, then forwards it; a forwarding failure is recorded without losing or retrying the stored message.
- **Subaddress folding.** `x+anything@` is normalized to `x@`, so blocking `x` blocks every tag variant.
- **One Worker, N domains.** Point each zone's Email Routing catch-all at the same Worker. Explicit routing rules for real addresses keep working — only unmatched recipients reach the sink.
- **Explicit outbound identities.** Any authenticated agent may send to any address, but every send names `from`. The CLI expands a local part with its configured default domain; the Worker API requires a full address on a separately onboarded sending domain. An unseen alias is created; a blocked alias cannot send.
- **The dominant query in one round trip:**

  ```
  GET /v1/emails?alias=netflix-x7f2&domain=example.com&from=netflix&limit=1&include=body
  ```

Start with the [user documentation](docs/README.md).
See [SPEC.md](SPEC.md) for the system design and [DECISIONS.md](DECISIONS.md) for design decisions.

## Repo layout

pnpm workspaces monorepo:

| Package | Purpose |
|---|---|
| [packages/shared](packages/shared/) | `@mailsink/shared` — API types + route constants, zero runtime logic. A contract change not applied on both sides fails `tsc`. |
| [packages/worker](packages/worker/) | The Cloudflare Worker: `email()` ingest handler + `/v1` HTTP API. |
| [packages/cli](packages/cli/) | Node CLI: task-verb client for the `/v1` API, typed against `@mailsink/shared`. |

## API

All routes require `Authorization: Bearer <API_TOKEN>`. Base path `/v1`, JSON in/out.

| Route | Purpose |
|---|---|
| `GET /v1/emails` | List, newest first. Filters: `alias`, `domain`, `from` (substring), `since`, `limit`, `cursor`, `include=body` |
| `GET /v1/emails/:id` | Full metadata + text body |
| `GET /v1/emails/:id/raw` | Stream the original `.eml` |
| `DELETE /v1/emails/:id` | Delete one message (D1 row + R2 object) |
| `DELETE /v1/emails?alias=&domain=` | Bulk purge an alias's mail (both params required) |
| `GET /v1/aliases` | List aliases. Filters: `q` (substring), `status`, `domain`, `routed=true` |
| `PATCH /v1/aliases/:domain/:alias` | Set `status`, `note`, and/or `forwardTo`. Upserts for pre-blocking and pre-routing |
| `GET /v1/sent` | List sent mail. Filters: `alias`, `domain`, `to`, `status` |
| `POST /v1/sent` | Validate, archive, and submit one structured send |
| `GET /v1/sent/:id` | Sent record and per-recipient lifecycle |
| `GET /v1/sent/:id/payload` | Archived versioned structured payload |
| `POST /v1/emails/:id/reply` | Build and submit a reply to an inbound message |
| `DELETE /v1/sent/:id` / `DELETE /v1/sent?alias=&domain=` | Delete one sent record or bulk-purge an alias's sent archive |

See [SPEC.md §7](SPEC.md) for full parameter semantics and the error envelope.

## Setup

### Prerequisites

- Node.js 24 LTS
- pnpm 11
- A Cloudflare account with one or more domains (Email Routing requires Cloudflare to be the zone's MX — exclusive of other inbound mail providers)

### Deploy the Worker

From the repository root:

```bash
pnpm install

cd packages/worker

# Opens Cloudflare login if Wrangler is not already authenticated
npx wrangler login

# One-time storage setup, if recreating this deployment
npx wrangler d1 create mailsink
cp wrangler.toml.example wrangler.toml
# Copy the D1 database_id from the create command into wrangler.toml
npx wrangler r2 bucket create mailsink-raw
npx wrangler queues create mailsink-email-events
npx wrangler d1 migrations apply mailsink --remote

npx wrangler deploy
```

Git ignores the local `wrangler.toml` because it identifies your Cloudflare resources.

The Worker `API_TOKEN` secret is created by `pnpm run dev init --cloudflare` in the CLI setup below. If you prefer to manage it manually, set it with `npx wrangler secret put API_TOKEN`, then use manual `pnpm run dev init`.

### Connect a domain (repeat per domain)

In the Cloudflare dashboard under **Compute → Email Service → Email Routing**:

1. Onboard the domain (Cloudflare installs MX/SPF/DKIM records automatically).
2. Keep explicit routing rules for real addresses — they take precedence over the catch-all.
3. Set the **catch-all rule** to Active with action **Send to a Worker** → `mailsink`.

See [SPEC.md §10](SPEC.md) for caveats (subaddressing toggle, Worker rename severing the binding).

### Enable sending (repeat per sending domain)

Run `mailsink setup sending [domain]` (the default domain is used when omitted). After confirmation, it creates or verifies the `mailsink-email-events` Queue; it never deploys or sends a test message. In the dashboard at **Compute > Email Service > Email Sending**, onboard the domain, publish/verify its `cf-bounce` MX, SPF, and DKIM records, create the domain event subscription, bind the Queue to the Worker, and deploy. Do not replace an existing DMARC record; start with `p=none` while validating. Keep Email Preview enabled initially: new-domain previews retain content for about seven days.

### Use the CLI

From the repo:

```bash
cd packages/cli
```

Recommended first-time setup uses Wrangler's Cloudflare browser login and then creates the Worker API token for mailsink:

```bash
pnpm run dev login
pnpm run dev whoami
pnpm run dev init --cloudflare
```

`login` opens Wrangler's Cloudflare OAuth flow when there is no active session. `whoami` confirms the active Cloudflare account. `init --cloudflare` generates a fresh Worker `API_TOKEN`, uploads it with `wrangler secret put API_TOKEN`, validates the Worker API, then stores that same token in the OS credential store.

`init --cloudflare` prompts for:

- **API URL:** the deployed Worker URL, for example `https://mailsink.<account-subdomain>.workers.dev`; a bare hostname is normalized to HTTPS
- **Default domain:** the email domain to use when a command does not include one, for example `example.com`

If you already created and stored a Worker `API_TOKEN` yourself, use manual init instead:

```bash
pnpm run dev init
```

Manual `init` prompts for the Worker URL, API token, and default domain, then validates the Worker API before saving. Both init modes write non-secret config to `~/.config/mailsink/config.json` (or `$XDG_CONFIG_HOME/mailsink/config.json`) and store the token in the OS credential store. For scripts or CI, `MAILSINK_URL` and `MAILSINK_TOKEN` override local config and keyring values.

Common commands:

```bash
mailsink login                            # open Wrangler's Cloudflare browser login
mailsink whoami                           # show the current Wrangler Cloudflare session
mailsink logout                           # clear Wrangler's Cloudflare session
mailsink latest netflix --from netflix      # show latest mail for matching alias(es)
mailsink ls inbox netflix --from netflix    # list received mail
mailsink show 01K7VTNH010000000000000000   # full metadata + text body
mailsink raw 01K7VTNH010000000000000000 -o message.eml
mailsink burn promo-new@example.com         # pre-block an explicit alias
mailsink unburn promo-new@example.com
mailsink aliases net --blocked
mailsink note netflix "netflix trial 2026-06"
mailsink route                              # list configured routes
mailsink route support@example.com may@email.com
mailsink route support --remove
mailsink send recipient@example.net --from agent@example.com --subject "Hello" --text "..."
mailsink send --request message.json         # use - to read the request from stdin
mailsink reply 01K7VTNH010000000000000000 --text "..." --all
mailsink ls sent support --to recipient@example.net --status delivered
mailsink payload <sent-id>
mailsink purge inbox netflix --yes
mailsink purge sent support --yes
mailsink rm 01K7VTNH010000000000000000
```

Fuzzy alias queries resolve through `GET /v1/aliases?q=...`. Read commands may fan out across multiple matches; write commands require exactly one match. `burn` and `route` can preconfigure an unseen alias when given an inline domain or `--exact`. Add `--json` to any command to emit the raw API response for scripting.

## Development

```bash
pnpm test                             # all workspace tests
pnpm run typecheck                    # tsc across packages

cd packages/worker
pnpm run dev                          # wrangler dev

cd ../cli
pnpm run dev --help                   # run the CLI from source
pnpm run build                        # build packages/cli/dist/index.js
```

`wrangler dev` exposes a local email injection endpoint for manual testing:

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=noreply@em.netflix.com&to=netflix-x7f2@example.com" \
  -H "Content-Type: message/rfc822" \
  --data-binary @test/fixtures/plain.eml
```

`route support@example.com you@gmail.com` is inbound-only store-then-forward. To send as that address from Gmail, run `mailsink provider gmail support@example.com`; use `smtp.mx.cloudflare.net`, port 465, implicit TLS, username `api_token`, and the alias as Gmail's Send As address. Create and manage the Email Sending:Edit token yourself; mailsink never handles it. Gmail SMTP sends bypass this archive and `ls sent`; their unmatched delivery events are ignored.

## Cost and delivery

Inbound storage can stay on free tiers. [Email Sending is public beta](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) and arbitrary recipients require Workers Paid: 3,000 messages/month are included, then $0.35 per 1,000. Daily quotas are adaptive and unpublished. Provider acceptance (`messageId`) is not delivery or mailbox receipt; use the Queue lifecycle, CLI status, and a real mailbox to verify a live send.

## Future work

The remaining deferred work is in [SPEC.md §13](SPEC.md) and [DECISIONS.md](DECISIONS.md) D-015.
