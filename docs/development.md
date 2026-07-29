# Development

Use Node.js 24 LTS and pnpm 11 for development.
Run commands from the repository root unless a step gives a different location.

## Install dependencies

```bash
pnpm install --frozen-lockfile
```

The workspace configuration is in `pnpm-workspace.yaml`.
The lockfile is `pnpm-lock.yaml`.

## Run the checks

Run all tests.

```bash
pnpm test
```

Run TypeScript checks.

```bash
pnpm run typecheck
```

Both commands must complete without an error.

## Run the Worker

Start the local Worker.

```bash
pnpm --dir packages/worker run dev
```

Wrangler prints the local URL.

Send a test email from a second terminal.

```bash
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=sender@example.net&to=docs-test@example.com" \
  -H "Content-Type: message/rfc822" \
  --data-binary @packages/worker/test/fixtures/plain.eml
```

## Run the CLI from source

Show the CLI help.

```bash
pnpm --dir packages/cli run dev --help
```

Put command arguments after `dev`.

```bash
pnpm --dir packages/cli run dev latest docs-test
```

Local Email Sending bindings simulate submission. They do not send real mail; `remote=true` does. Do not use remote mode or a live test send without confirmation. A live check needs the archived R2/D1 record, provider `messageId`, terminal Queue event, CLI status, mailbox receipt, and SPF/DKIM/DMARC verification.

## Build the CLI

Build the Node.js entry point.

```bash
pnpm --dir packages/cli run build
```

esbuild writes `packages/cli/dist/index.js`.
Do not commit the `dist` directory.

Check the package contents.

```bash
pnpm --dir packages/cli pack --dry-run
```

The package must contain `dist/index.js` and `package.json`.

## Change a shared API type

If you change the shared API contract, update these parts:

1. Update `packages/shared`.
2. Update the Worker.
3. Update the CLI.
4. Update the related tests.
5. Run `pnpm test`.
6. Run `pnpm run typecheck`.
