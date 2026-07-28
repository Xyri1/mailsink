import PostalMime from "postal-mime";
import { ulid } from "ulidx";
import { normalizeRecipient } from "./core";
import type { Env } from "./types";

const TEXT_LIMIT = 65_536;
const FORWARD_ERROR_LIMIT = 1_000;

export interface ForwardableEmailMessageLike {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject(reason: string): void;
  forward(destination: string): void | Promise<void>;
}

interface ParsedMetadata {
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  dateHeader: number | null;
  textBody: string | null;
  hasHtml: number;
  attachmentCount: number;
  parseError: number;
}

export async function handleEmail(message: ForwardableEmailMessageLike, env: Env) {
  const recipient = normalizeRecipient(message.to);
  const alias = await env.DB.prepare(
    "SELECT status, forward_to FROM aliases WHERE alias = ? AND domain = ?"
  ).bind(recipient.alias, recipient.domain).first<{ status: string; forward_to: string | null }>();

  if (alias?.status === "blocked") {
    if (env.BLOCK_MODE !== "drop") message.setReject("address unavailable");
    return;
  }

  const buffer = await new Response(message.raw).arrayBuffer();
  const id = ulid();
  const r2Key = `${recipient.domain}/${recipient.alias}/${id}.eml`;
  await env.RAW.put(r2Key, buffer, { httpMetadata: { contentType: "message/rfc822" } });

  const receivedAt = Date.now();
  const metadata = await parseSafely(buffer, message.from);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO emails (
        id, alias, domain, to_addr, envelope_from, from_addr, from_name, subject,
        date_header, received_at, size_bytes, text_body, has_html, attachment_count,
        parse_error, r2_key, forward_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      recipient.alias,
      recipient.domain,
      recipient.toAddr,
      message.from,
      metadata.fromAddr,
      metadata.fromName,
      metadata.subject,
      metadata.dateHeader,
      receivedAt,
      message.rawSize || buffer.byteLength,
      metadata.textBody,
      metadata.hasHtml,
      metadata.attachmentCount,
      metadata.parseError,
      r2Key,
      alias?.forward_to ?? null
    ),
    env.DB.prepare(`
      INSERT INTO aliases (alias, domain, status, note, first_seen_at, last_seen_at, email_count)
      VALUES (?, ?, 'active', NULL, ?, ?, 1)
      ON CONFLICT(alias, domain) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        email_count = email_count + 1
    `).bind(recipient.alias, recipient.domain, receivedAt, receivedAt)
  ]);

  if (alias?.forward_to) {
    try {
      await message.forward(alias.forward_to);
    } catch (error) {
      const forwardError = (error instanceof Error ? error.message : String(error)).slice(0, FORWARD_ERROR_LIMIT);
      try {
        await env.DB.prepare("UPDATE emails SET forward_error = ? WHERE id = ?").bind(forwardError, id).run();
      } catch (persistError) {
        console.error("failed to record forwarding error", persistError);
      }
    }
  }
}

async function parseSafely(buffer: ArrayBuffer, envelopeFrom: string): Promise<ParsedMetadata> {
  try {
    const parsed = await PostalMime.parse(buffer);
    const date = parsed.date ? Date.parse(parsed.date) : Number.NaN;
    return {
      fromAddr: parsed.from?.address || envelopeFrom,
      fromName: parsed.from?.name || null,
      subject: parsed.subject || null,
      dateHeader: Number.isNaN(date) ? null : date,
      textBody: parsed.text ? parsed.text.slice(0, TEXT_LIMIT) : null,
      hasHtml: parsed.html ? 1 : 0,
      attachmentCount: parsed.attachments?.length ?? 0,
      parseError: 0
    };
  } catch {
    return {
      fromAddr: envelopeFrom,
      fromName: null,
      subject: null,
      dateHeader: null,
      textBody: null,
      hasHtml: 0,
      attachmentCount: 0,
      parseError: 1
    };
  }
}
