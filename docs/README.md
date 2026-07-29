# Mailsink documentation

Mailsink receives email for catch-all addresses and sends from explicitly named aliases. It stores inbound raw mail and permanent, versioned outbound structured payloads in R2; D1 is the searchable index and delivery-status store.
Use the CLI to read, route, block, send, reply, inspect delivery state, or delete mail.

## Start here

1. Use [Get started](getting-started.md) to deploy Mailsink and connect a domain.
2. Use [Configuration](configuration.md) to set Worker and CLI values.
3. Use the [CLI guide](../packages/cli/USAGE.md) to operate Mailsink.
4. Use [Development](development.md) to test or change the project.

## Terms

- **Alias:** The name before `@` in an email address.
- **Burn:** Block an alias so that Mailsink does not store new email for it.
- **Route:** Store mail for one alias, then forward it to a verified destination.
- **Sending domain:** A domain separately onboarded with Cloudflare Email Sending; it is not implied by inbound Email Routing.
- **Accepted:** Cloudflare accepted/queued an outbound submission. It is not delivered or mailbox receipt.
- **CLI:** The `mailsink` command-line interface.
- **Worker:** The Cloudflare Worker that receives email and provides the API.
- **Raw message:** The original email in RFC 5322 format.

## Project references

- [System specification](../SPEC.md)
- [Decision log](../DECISIONS.md)
