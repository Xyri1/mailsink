import type { AliasRecord } from "@mailsink/shared";
import { CliFailure } from "./config";
import type { MailsinkClient } from "./client";

export interface AliasQuery {
  alias: string;
  domain: string;
  explicit: boolean;
  label: string;
}

export function parseAliasQuery(query: string, defaultDomain: string, domainOverride?: string): AliasQuery {
  const [alias, inlineDomain, extra] = query.split("@");
  if (!alias || extra !== undefined) throw new CliFailure(`invalid alias query ${query}`);
  const normalizedAlias = alias.toLowerCase();
  const domain = (domainOverride ?? inlineDomain ?? defaultDomain).toLowerCase();
  return { alias: normalizedAlias, domain, explicit: inlineDomain !== undefined, label: `${normalizedAlias}@${domain}` };
}

export async function resolveReadAliases(
  client: MailsinkClient,
  query: string,
  defaultDomain: string,
  options: { domain?: string; exact?: boolean } = {}
) {
  const parsed = parseAliasQuery(query, defaultDomain, options.domain);
  if (options.exact) return [toAliasRecord(parsed)];

  const { aliases } = await client.listAliases({ q: parsed.alias, domain: parsed.domain });
  if (aliases.length === 0) throw new CliFailure(`no aliases matched ${parsed.label}`);
  return aliases;
}

export async function resolveOneWriteAlias(
  client: MailsinkClient,
  query: string,
  defaultDomain: string,
  options: { domain?: string; exact?: boolean; allowPreBlock?: boolean } = {}
) {
  const parsed = parseAliasQuery(query, defaultDomain, options.domain);
  if (options.exact) return toAliasRecord(parsed);

  const { aliases } = await client.listAliases({ q: parsed.alias, domain: parsed.domain });
  if (aliases.length === 1) return aliases[0]!;
  if (aliases.length > 1) {
    throw new CliFailure([
      `multiple aliases matched ${parsed.label}`,
      ...aliases.map((record) => `  ${record.alias}@${record.domain}`)
    ].join("\n"));
  }
  if (options.allowPreBlock && parsed.explicit) return toAliasRecord(parsed);
  throw new CliFailure(`no aliases matched ${parsed.label}`);
}

function toAliasRecord(query: AliasQuery): AliasRecord {
  return {
    alias: query.alias,
    domain: query.domain,
    status: "active",
    note: null,
    forwardTo: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    emailCount: 0
  };
}
