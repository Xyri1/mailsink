---
name: mailsink-cli
description: Use and maintain the Mailsink command-line client in this repository. Use when running, testing, debugging, extending, documenting, packaging, or explaining packages/cli; changing CLI commands, configuration and OS credential storage, fuzzy alias resolution, Worker /v1 API calls, Wrangler-assisted setup, output formatting, or the published CLI artifact.
---

# Mailsink CLI

## Work from the checkout

Work from the repository root that contains `pnpm-workspace.yaml`.
Inspect the current files before making changes.

Read only the references needed for the task:

- Read `packages/cli/USAGE.md` for user-visible command behavior.
- Read `DECISIONS.md` D-016 for the architectural boundary.
- Read `packages/cli/package.json` for current scripts and package contents.
- Read `packages/shared/src/index.ts` when changing the API contract.
- Read `docs/configuration.md` for config and secret handling.
- Read `docs/development.md` for workspace verification.

Do not use personal checkout paths or assume that globally installed tools exist.
Use pnpm and Node.js.

## Preserve the design

- Keep the CLI a task-verb client for the Worker `/v1` API.
- Keep normal mail commands independent of direct D1, R2, and Cloudflare account APIs.
- Use Wrangler only for `login`, `logout`, `whoami`, and Cloudflare-assisted initialization.
- Keep non-secret URL and default-domain values in the config file.
- Keep the API token in the OS credential store through `@napi-rs/keyring`.
- Let `MAILSINK_URL` and `MAILSINK_TOKEN` override stored values for scripts and CI.
- Keep shared API routes and types in `@mailsink/shared`.
- Preserve fuzzy alias lookup through `GET /v1/aliases`.
- Allow read commands to combine multiple matches.
- Require one unambiguous match for fuzzy writes.
- Preserve the current explicit-write rules: `--exact` bypasses lookup for every write command, and `burn` can also pre-block with an inline domain.
- Keep `--json` output API-shaped and free of human formatting.

Treat exact write behavior as an existing contract mismatch:
the source bypasses lookup for every `--exact` write, while
`packages/cli/USAGE.md` and D-016 describe pre-blocking only for `burn`.
If a task touches this boundary, reconcile the source, tests, and documented
contract explicitly instead of silently broadening behavior.

Treat `.env`, `.dev.vars`, `.secrets`, and the local
`packages/worker/wrangler.toml` as untracked local state.
Do not print, copy, or commit their values.

## Run the CLI

Run repository-local commands from the repository root:

```bash
pnpm --dir packages/cli run dev --help
pnpm --dir packages/cli run dev latest netflix --from netflix
pnpm --dir packages/cli run dev ls inbox netflix --from netflix
```

Use `mailsink ...` only when testing an installed package.
Use `npx wrangler ...` for direct Wrangler commands.
Do not commit `packages/cli/dist`.

## Change the correct module

- Change command wiring, prompts, output routing, and Wrangler helpers in `packages/cli/src/index.ts`.
- Change config files, environment overrides, or keyring behavior in `packages/cli/src/config.ts`.
- Change HTTP requests and API error handling in `packages/cli/src/client.ts`.
- Change CLI fuzzy or exact resolution policy in `packages/cli/src/resolve.ts`.
- Change the substring-matching algorithm in `packages/worker/src/api.ts`; update Worker tests and the CLI HTTP fake together because SQL `LIKE` and JavaScript `includes` have different case and wildcard behavior.
- Change human-readable output in `packages/cli/src/format.ts`.
- Add behavior tests under `packages/cli/test`.

Update the shared types, Worker, CLI, and related tests together when the
Worker API contract changes.

## Verify changes

For CLI-only changes, run:

```bash
pnpm --filter @mailsink/cli test
pnpm --filter @mailsink/cli run typecheck
```

For runtime or packaging changes, also run:

```bash
pnpm --filter @mailsink/cli run build
node packages/cli/dist/index.js --help
pnpm --dir packages/cli pack --dry-run
```

For shared API changes, run the full workspace checks:

```bash
pnpm test
pnpm run typecheck
```

For Worker substring-matching changes, also run:

```bash
pnpm --filter @mailsink/worker test
pnpm --filter @mailsink/worker run typecheck
```

Keep a Wrangler-only Windows failure separate from a project regression when
the same failure is an upstream Wrangler issue.
