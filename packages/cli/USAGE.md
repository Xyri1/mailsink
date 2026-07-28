# mailsink CLI usage

The mailsink CLI reads and manages mail through the Worker `/v1` API. It also uses Wrangler for Cloudflare destination verification when configuring a route.

## Run it from source

From this package:

```bash
cd packages/cli
pnpm run dev --help
```

Examples in this guide use the installed command name, `mailsink`. While developing in the repo, replace `mailsink` with `pnpm run dev`:

```bash
pnpm run dev latest netflix --from netflix
```

## First-time setup

Recommended setup uses Wrangler's Cloudflare browser login to generate a Worker API token, upload it as the Worker's `API_TOKEN` secret, validate the Worker API, and store the token locally.

```bash
mailsink login
mailsink whoami
mailsink init --cloudflare
```

`init --cloudflare` prompts for:

- API URL, for example `https://mailsink.your-subdomain.workers.dev`
- Default domain, for example `example.com`

If you already have a Worker API token, use manual setup instead:

```bash
mailsink init
```

Manual setup prompts for the API URL, API token, and default domain, then validates the Worker API before saving.

## Configuration

`init` writes non-secret config to:

```text
~/.config/mailsink/config.json
```

If `XDG_CONFIG_HOME` is set, the config path is:

```text
$XDG_CONFIG_HOME/mailsink/config.json
```

The config file contains only:

```json
{
  "url": "https://mailsink.your-subdomain.workers.dev",
  "defaultDomain": "example.com"
}
```

The API token is stored in the OS credential store under service `mailsink`, account `api-token`.

For scripts or CI, environment variables override local state:

```bash
MAILSINK_URL=https://mailsink.your-subdomain.workers.dev MAILSINK_TOKEN=... mailsink ls netflix
```

`MAILSINK_URL` overrides the stored URL. `MAILSINK_TOKEN` overrides the credential-store token. The default domain still comes from the config file unless a command uses `--domain`.

## Global options

```text
--json             Emit the raw API response for scripting.
--domain <domain> Override the configured default domain.
--exact           Treat an alias query as an exact alias name.
```

Global options go before the command:

```bash
mailsink --json ls netflix
mailsink --domain example.com latest netflix
mailsink --exact burn netflix-x7f2
```

## Daily commands

Read the latest matching mail:

```bash
mailsink latest netflix
mailsink latest netflix --from netflix
```

List recent mail:

```bash
mailsink ls
mailsink ls netflix
mailsink ls netflix --limit 10
mailsink ls netflix --from noreply
```

Show one message by id:

```bash
mailsink show 01K7VTNH010000000000000000
```

Download or print the original `.eml`:

```bash
mailsink raw 01K7VTNH010000000000000000 -o message.eml
mailsink raw 01K7VTNH010000000000000000
```

Block and unblock aliases:

```bash
mailsink burn promo-new@example.com
mailsink unburn promo-new
```

List aliases:

```bash
mailsink aliases
mailsink aliases net
mailsink aliases net --blocked
```

Annotate an alias:

```bash
mailsink note netflix "netflix trial 2026-06"
```

Route an alias after storing each message:

```bash
mailsink route
mailsink route support@example.com may@email.com
mailsink route support --remove
```

The destination must be verified on the active Wrangler Cloudflare account. If it is missing, `route` asks Cloudflare to send a verification email and leaves the mapping unchanged. Verify the address, then rerun the same command. Routes can be configured before an alias receives mail and appear in `mailsink route` immediately with zero stored messages.

Delete mail:

```bash
mailsink rm 01K7VTNH010000000000000000
mailsink purge netflix
mailsink purge netflix --yes
```

Manage the Wrangler Cloudflare session:

```bash
mailsink login
mailsink whoami
mailsink logout
```

These commands affect Wrangler's Cloudflare session only. Mail commands talk to the Worker API with the stored Worker API token; `route` additionally uses that Wrangler session to check or request destination verification.

## Alias matching

Most commands accept an alias query rather than requiring the full generated alias. A query like `netflix` resolves through:

```text
GET /v1/aliases?q=netflix
```

If the query has no inline domain, the configured default domain is used. Use either an inline domain or `--domain` to choose another domain:

```bash
mailsink latest netflix@example.com
mailsink --domain example.com latest netflix
```

Read commands can match multiple aliases:

- `latest <query>` prints the latest message for each matching alias.
- `ls <query>` merges matching aliases' messages newest first.
- `aliases [query]` lists matching aliases.

Write commands require exactly one match:

- `burn <alias>`
- `unburn <alias>`
- `note <alias> <text>`
- `route <alias> <destination>`
- `route <alias> --remove`
- `purge <alias>`

If a write query matches multiple aliases, the CLI exits with an error and lists candidates. Use a longer query, `--exact`, or an inline domain to disambiguate.

`burn` and `route` can preconfigure a never-seen alias only when intent is explicit:

```bash
mailsink burn promo-new@example.com
mailsink --exact burn promo-new
mailsink route support@example.com may@email.com
mailsink --exact route support may@email.com
```

A bare fuzzy query that matches nothing is an error.

## JSON output

Use `--json` when another program will consume the output:

```bash
mailsink --json latest netflix
mailsink --json aliases net --blocked
mailsink --json show 01K7VTNH010000000000000000
```

Human formatting is skipped in JSON mode; the CLI prints the raw API-shaped payload.

## Build and verify

Build the Node CLI entrypoint:

```bash
pnpm run build
```

Run CLI checks from the repo root:

```bash
pnpm --filter @mailsink/cli test
pnpm --filter @mailsink/cli run typecheck
```
