import type { AliasRecord, EmailSummary, EmailWithBody } from "@mailsink/shared";
import type { AliasRow, EmailRow } from "./types";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function normalizeRecipient(to: string) {
  const at = to.lastIndexOf("@");
  const local = at === -1 ? to : to.slice(0, at);
  const domain = at === -1 ? "" : to.slice(at + 1).toLowerCase();
  return {
    alias: local.split("+")[0]!.toLowerCase(),
    domain,
    toAddr: to
  };
}

export function normalizePathAlias(alias: string) {
  return decodeURIComponent(alias).toLowerCase();
}

export function ulidFloor(timestampMs: number) {
  let value = Math.trunc(timestampMs);
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    encoded = CROCKFORD[value % 32]! + encoded;
    value = Math.floor(value / 32);
  }
  return `${encoded}0000000000000000`;
}

export function mapEmailRow(row: EmailRow, includeBody: true): EmailWithBody;
export function mapEmailRow(row: EmailRow, includeBody?: false): EmailSummary;
export function mapEmailRow(row: EmailRow, includeBody = false): EmailSummary | EmailWithBody {
  const summary: EmailSummary = {
    id: row.id,
    alias: row.alias,
    domain: row.domain,
    toAddr: row.to_addr,
    envelopeFrom: row.envelope_from,
    fromAddr: row.from_addr,
    fromName: row.from_name,
    subject: row.subject,
    dateHeader: row.date_header,
    receivedAt: row.received_at,
    sizeBytes: row.size_bytes,
    hasHtml: row.has_html === 1,
    attachmentCount: row.attachment_count,
    parseError: row.parse_error === 1,
    forwardTo: row.forward_to,
    forwardError: row.forward_error
  };
  return includeBody ? { ...summary, textBody: row.text_body } : summary;
}

export function mapAliasRow(row: AliasRow): AliasRecord {
  return {
    alias: row.alias,
    domain: row.domain,
    status: row.status,
    note: row.note,
    forwardTo: row.forward_to,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    emailCount: row.email_count
  };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function apiError(code: "unauthorized" | "bad_request" | "not_found" | "internal", message: string, status: number) {
  return json({ error: { code, message } }, status);
}
