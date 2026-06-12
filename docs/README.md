# Mailsink documentation

Mailsink receives email for catch-all addresses. It stores each raw message and its metadata.
Use the command-line interface (CLI) to read, block, or delete email.

## Start here

1. Use [Get started](getting-started.md) to deploy Mailsink and connect a domain.
2. Use [Configuration](configuration.md) to set Worker and CLI values.
3. Use the [CLI guide](../packages/cli/USAGE.md) to operate Mailsink.
4. Use [Development](development.md) to test or change the project.

## Terms

- **Alias:** The name before `@` in an email address.
- **Burn:** Block an alias so that Mailsink does not store new email for it.
- **CLI:** The `mailsink` command-line interface.
- **Worker:** The Cloudflare Worker that receives email and provides the API.
- **Raw message:** The original email in RFC 5322 format.

## Project references

- [System specification](../SPEC.md)
- [Decision log](../DECISIONS.md)

