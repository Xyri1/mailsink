import pc from "picocolors";
import type { AliasRecord, EmailSummary, EmailWithBody } from "@mailsink/shared";

interface FormatOptions {
  now: number;
  color: boolean;
}

export function formatEmailList(emails: EmailSummary[], options: FormatOptions) {
  return emails.map((email) => [
    paint(options).dim(relativeTime(email.receivedAt, options.now)).padEnd(8),
    email.parseError ? "!" : " ",
    `${email.alias}@${email.domain}`.padEnd(28),
    paint(options).bold(email.fromName ?? email.fromAddr),
    email.subject ?? "(no subject)"
  ].join(" ")).join("\n");
}

export function formatEmailWithBody(email: EmailWithBody, options: FormatOptions) {
  const lines = [
    `From: ${email.fromName ? `${email.fromName} <${email.fromAddr}>` : email.fromAddr}`,
    `To: ${email.toAddr}`,
    `Subject: ${email.subject ?? "(no subject)"}`,
    `Date: ${new Date(email.dateHeader ?? email.receivedAt).toISOString()}`,
    `Attachments: ${email.attachmentCount}`
  ];

  if (email.forwardTo) lines.push(`Route: ${email.forwardTo}`);
  if (email.forwardError) lines.push(`Forward error: ${email.forwardError}`);
  lines.push("");

  if (email.textBody !== null) {
    lines.push(email.textBody);
  } else if (email.hasHtml) {
    lines.push(`HTML-only message; mailsink raw ${email.id} for the original`);
  }

  if (email.parseError) lines.unshift("! parse warning");
  return lines.join("\n");
}

export function formatAliases(aliases: AliasRecord[], options: FormatOptions) {
  return aliases.map((record) => [
    relativeTime(record.lastSeenAt, options.now).padEnd(8),
    `${record.alias}@${record.domain}`.padEnd(28),
    record.status.padEnd(7),
    String(record.emailCount).padStart(3),
    record.note ?? ""
  ].join(" ")).join("\n");
}

export function formatRoutes(aliases: AliasRecord[]) {
  return aliases.length === 0 ? "no routes configured" : aliases.map((record) =>
    `${record.alias}@${record.domain} -> ${record.forwardTo}${record.status === "blocked" ? " (blocked)" : ""}`
  ).join("\n");
}

export function relativeTime(value: number, now: number) {
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function paint(options: FormatOptions) {
  if (!options.color) return { dim: (value: string) => value, bold: (value: string) => value };
  return pc;
}
