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
| Email Sending binding | Submits outbound mail for an onboarded sending domain. |
| Queue binding | Receives per-recipient Email Sending delivery events. |

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

The same bearer token authorizes all inbound and outbound operations. There is no custom rate limit; keep it in the credential store and rotate it if it is exposed.

## Sending-domain configuration

Inbound Email Routing does not authorize sending.
Onboard each `from` domain separately with
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/).
The CLI expands local `from` values with its default domain.
Direct API requests require complete addresses.
Cloudflare requires a Workers Paid plan to send to arbitrary recipients.
Verify the `cf-bounce` MX, SPF, DKIM, and DMARC records.
Do not replace an existing DMARC record.
Use `p=none` while you test a new DMARC configuration.

`mailsink setup sending [domain]` creates or verifies
`mailsink-email-events` after confirmation.
Onboard the domain in **Compute > Email Service > Email Sending**.
Then select the Queue and create the domain event subscription on its
**Subscriptions** tab.
The Worker configuration already declares the Queue consumer.
Deploy the Worker after the Queue and subscription are ready.

Wrangler 4.115.0 cannot create an `email.sending` event subscription.
Its `queues subscription create` command has no Email Sending source or domain
option.
Use the Cloudflare dashboard or REST API for this subscription.

A send is first `submitting`.
It becomes `accepted` after provider submission.
Events change each recipient to `delivered`, `deferred`, `bounced`, `failed`,
`rejected`, or `complained`.
Mailsink ignores events that it cannot match.
This includes events from Gmail SMTP sends.

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
mailsink ls inbox
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
