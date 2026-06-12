# mailsink

A catch-all email sink for domains on Cloudflare, built for **disposable per-service aliases**.

Sign up anywhere with an invented address — `netflix-x7f2@example.com` — with no pre-registration. Inbound mail is stored durably and read through a small authenticated JSON API. When an alias leaks to spammers, **burn it**: mail to it is rejected during the SMTP transaction and nothing is stored.

```
                        ┌────────────────────────────────────┐
  SMTP (port 25)        │  Worker: mailsink                  │
  ───────────────►      │                                    │
  Email Routing         │  email()  ── ingest pipeline ──►   │──► R2: raw .eml
  catch-all rule        │                                    │──► D1: emails, aliases
                        │  fetch()  ── /v1 JSON API   ◄──────│◄── CLI (bearer token)
                        └────────────────────────────────────┘
```

## How it works

- **Implicit aliases.** An alias exists the moment it receives mail. No registration step.
- **Burning.** `PATCH /v1/aliases/:domain/:alias` with `{"status": "blocked"}` makes future mail bounce at SMTP time (or drop silently with `BLOCK_MODE=drop`). Upserts, so you can pre-block an alias before it's ever used.
- **Durable storage.** The raw RFC 5322 message in R2 is canonical — written before parsing, never lost even when parsing fails. D1 holds queryable metadata and a truncated text body.
- **Subaddress folding.** `x+anything@` is normalized to `x@`, so blocking `x` blocks every tag variant.
- **One Worker, N domains.** Point each zone's Email Routing catch-all at the same Worker. Explicit routing rules for real addresses keep working — only unmatched recipients reach the sink.
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
| `GET /v1/aliases` | List aliases. Filters: `q` (substring), `status`, `domain` |
| `PATCH /v1/aliases/:domain/:alias` | Set `status` (`active`/`blocked`) and/or `note`. Upserts — this is how pre-blocking works |

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
mailsink ls netflix --limit 10              # list recent mail, newest first
mailsink show 01K7VTNH010000000000000000   # full metadata + text body
mailsink raw 01K7VTNH010000000000000000 -o message.eml
mailsink burn promo-new@example.com         # pre-block an explicit alias
mailsink unburn promo-new@example.com
mailsink aliases net --blocked
mailsink note netflix "netflix trial 2026-06"
mailsink rm 01K7VTNH010000000000000000
mailsink purge netflix --yes
```

Fuzzy alias queries resolve through `GET /v1/aliases?q=...`. Read commands may fan out across multiple matches; write commands require exactly one match unless `burn` is given an explicit alias with `--exact` or an inline domain for pre-blocking. Add `--json` to any command to emit the raw API response for scripting.

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

## Cost

Designed to run on Cloudflare's free tiers (Workers, D1, R2, Email Routing). Expected cost at personal scale: **$0**. See [SPEC.md §11](SPEC.md) for limits.

## Future work

The Worker and CLI are implemented with tests. [SPEC.md §13](SPEC.md) lists deferred features, and [DECISIONS.md](DECISIONS.md) D-015 gives the trigger for each feature.
