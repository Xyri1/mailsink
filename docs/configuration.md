# Configuration

Mailsink has Worker configuration and CLI configuration.
Keep secrets out of files that you commit to the repository.

## Worker configuration

Copy `packages/worker/wrangler.toml.example` to `packages/worker/wrangler.toml`.
Wrangler reads the local `wrangler.toml` file.
Git ignores this file because it identifies your Cloudflare resources.
The file defines these items:

| Item | Purpose |
|---|---|
| `name` | Sets the Worker name. |
| `main` | Sets the Worker entry point. |
| `compatibility_date` | Sets the Cloudflare runtime date. |
| `BLOCK_MODE` | Controls blocked email behavior. |
| `DB` | Binds the D1 database. |
| `RAW` | Binds the R2 bucket. |

### Block mode

Use one of these values for `BLOCK_MODE`:

- `reject`: Reject email for a blocked alias.
- `drop`: Accept and discard email for a blocked alias.

Use `reject` unless you must discard blocked email without a rejection.

### API token

The Worker reads the API token from the `API_TOKEN` secret.
Do not put this token in `wrangler.toml`.

Set the secret manually from `packages/worker`.

```bash
npx wrangler secret put API_TOKEN
```

The `mailsink init --cloudflare` command can also set this secret.

For local Worker development, put secrets in
`packages/worker/.dev.vars`.
Do not use `.dev.vars` and `.env` together.
Git ignores both file types.

## CLI configuration

Run this command to create the CLI configuration:

```bash
mailsink init
```

The CLI writes non-secret values to this file:

```text
~/.config/mailsink/config.json
```

If `XDG_CONFIG_HOME` has a value, the CLI uses this path:

```text
$XDG_CONFIG_HOME/mailsink/config.json
```

The file has this structure:

```json
{
  "url": "https://mailsink.your-subdomain.workers.dev",
  "defaultDomain": "example.com"
}
```

The CLI stores the API token in the operating system credential store.
It uses service `mailsink` and account `api-token`.

## Environment variables

Use environment variables for scripts and continuous integration.

```bash
MAILSINK_URL=https://mailsink.your-subdomain.workers.dev \
MAILSINK_TOKEN=replace-with-a-token \
mailsink ls
```

`MAILSINK_URL` overrides the URL in the configuration file.
`MAILSINK_TOKEN` overrides the token in the credential store.
The default domain comes from the configuration file.
Use `--domain` to override it for one command.

## Change the token

Run Cloudflare initialization again to replace the token.

```bash
mailsink init --cloudflare
```

The command replaces the Worker secret and the local credential.
