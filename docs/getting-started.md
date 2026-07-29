# Get started

Use this procedure to deploy Mailsink and connect one domain.
Complete the steps in this sequence.

## Requirements

Make sure that you have these items:

- Node.js 24 LTS
- pnpm 11
- A Cloudflare account
- A domain that uses Cloudflare DNS

> **CAUTION:** Cloudflare changes the domain MX records during Email Routing setup.
> Do not continue if another service must receive all email for the domain.

## 1. Install the packages

Open a terminal in the repository root.

```bash
pnpm install --frozen-lockfile
```

## 2. Create the storage resources

Go to the Worker package.

```bash
cd packages/worker
npx wrangler login
```

Create the D1 database.

```bash
npx wrangler d1 create mailsink
```

Create the local Worker configuration.

```bash
cp wrangler.toml.example wrangler.toml
```

Copy the new `database_id` value to the local `wrangler.toml` file.
Put the value in the `[[d1_databases]]` section.
Git ignores this file because it identifies your Cloudflare resources.

Create the R2 bucket.

```bash
npx wrangler r2 bucket create mailsink-raw
```

Create the Queue declared by the Worker configuration.

```bash
npx wrangler queues create mailsink-email-events
```

Apply the database migration.

```bash
npx wrangler d1 migrations apply mailsink --remote
```

## 3. Deploy the Worker

Run this command from `packages/worker`.

```bash
npx wrangler deploy
```

Record the Worker URL.
You must give this URL to the CLI.

## 4. Connect the domain

1. Open Email Routing in the Cloudflare dashboard.
2. Enable Email Routing for the domain.
3. Keep the routing rules for real email addresses.
4. Set the catch-all action to **Send to a Worker**.
5. Select the `mailsink` Worker.

Repeat these steps for each additional domain.

## 5. Initialize the CLI

Go to the CLI package.

```bash
cd ../cli
pnpm run dev init --cloudflare
```

Wrangler opens the Cloudflare login page if a login is necessary.
Enter the Worker URL and the default email domain.

The command completes these steps:

1. It creates an API token.
2. It sends the token to the Worker.
3. It tests the Worker API.
4. It stores the token in the operating system credential store.

If you already have an API token, use manual initialization.

```bash
pnpm run dev init
```

## 6. Test the system

Send an email to a new alias on the connected domain.
For example, send an email to `docs-test@example.com`.
Replace `example.com` with your domain.

Read the email.

```bash
pnpm run dev latest docs-test
```

If the command shows the message, the setup is complete.

## 7. Enable outbound sending (optional, confirmation required)

Do not deploy or send a live test without your confirmation. Start the guided setup:

```bash
mailsink setup sending [domain]
```

It uses the configured default domain if omitted. After confirmation, it verifies the `mailsink-email-events` Queue (or creates it for an upgraded deployment). In **Compute > Email Service > Email Sending**, separately onboard the sending domain, publish/verify its `cf-bounce` MX, SPF, and DKIM records, create its domain event subscription, bind the Queue to the Worker, and deploy. Those dashboard steps and any live send remain human actions. Do not overwrite an existing DMARC record; use `p=none` during validation. Keep Email Preview enabled initially (it retains content on new domains for about seven days).

Before declaring a live send complete, confirm: R2/D1 archive rows, the provider `messageId`, a terminal Queue event, `mailsink ls sent` status, mailbox receipt, and SPF/DKIM/DMARC results.

## Next steps

- Read [Configuration](configuration.md).
- Read the [CLI guide](../packages/cli/USAGE.md).
