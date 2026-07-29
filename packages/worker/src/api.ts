import type {
  EmailAddressInput,
  ReplyEmailRequest,
  SendEmailRequest
} from "@mailsink/shared";
import {
  apiError,
  json,
  mapAliasRow,
  mapEmailRow,
  mapSentEmailRow,
  mapSentRecipientRow,
  normalizePathAlias,
  normalizeRecipient,
  ulidFloor
} from "./core";
import { isAuthorized } from "./auth";
import type {
  AliasRow,
  EmailRow,
  Env,
  QueueBatch,
  SentEmailRow,
  SentRecipientRow
} from "./types";

const DELIVERY_EVENTS = new Set(["delivered", "deferred", "bounced", "failed", "rejected", "complained"]);
const DELIVERY_EVENT_PREFIX = "cf.email.sending.message.";
const ERROR_LIMIT = 1_000;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 32;
const MAX_SUBJECT_LENGTH = 998;

export async function handleFetch(request: Request, env: Env) {
  if (!await isAuthorized(request, env)) {
    return apiError("unauthorized", "missing or invalid bearer token", 401);
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/v1/emails" && request.method === "GET") return listEmails(url, env);
    if (path === "/v1/emails" && request.method === "DELETE") return deleteEmailsByAlias(url, env);
    if (path === "/v1/aliases" && request.method === "GET") return listAliases(url, env);
    if (path === "/v1/sent" && request.method === "POST") return createSentEmail(request, env);
    if (path === "/v1/sent" && request.method === "GET") return listSentEmails(url, env);
    if (path === "/v1/sent" && request.method === "DELETE") return deleteSentEmailsByAlias(url, env);

    const reply = path.match(/^\/v1\/emails\/([^/]+)\/reply$/);
    if (reply && request.method === "POST") return replyToEmail(decodeURIComponent(reply[1]!), request, env);

    const sentPayload = path.match(/^\/v1\/sent\/([^/]+)\/payload$/);
    if (sentPayload && request.method === "GET") return getSentPayload(decodeURIComponent(sentPayload[1]!), env);

    const sentEmail = path.match(/^\/v1\/sent\/([^/]+)$/);
    if (sentEmail && request.method === "GET") return getSentEmail(decodeURIComponent(sentEmail[1]!), env);
    if (sentEmail && request.method === "DELETE") return deleteSentEmail(decodeURIComponent(sentEmail[1]!), env);

    const emailRaw = path.match(/^\/v1\/emails\/([^/]+)\/raw$/);
    if (emailRaw && request.method === "GET") return getRawEmail(emailRaw[1]!, env);

    const email = path.match(/^\/v1\/emails\/([^/]+)$/);
    if (email && request.method === "GET") return getEmail(email[1]!, env);
    if (email && request.method === "DELETE") return deleteEmail(email[1]!, env);

    const alias = path.match(/^\/v1\/aliases\/([^/]+)\/([^/]+)$/);
    if (alias && request.method === "PATCH") return patchAlias(alias[1]!, alias[2]!, request, env);

    return apiError("not_found", "route not found", 404);
  } catch (error) {
    return apiError("internal", error instanceof Error ? error.message : "internal error", 500);
  }
}

async function createSentEmail(request: Request, env: Env) {
  const body = await request.json().catch(() => null);
  return sendEmail(body as SendEmailRequest, env);
}

async function sendEmail(body: SendEmailRequest, env: Env) {
  const validationError = validateSendRequest(body);
  if (validationError) return apiError("bad_request", validationError, 400);
  const existing = await env.DB.prepare("SELECT * FROM sent_emails WHERE id = ?").bind(body.id).first<SentEmailRow>();
  if (existing) return existingSendResponse(existing, env);

  const fromAddr = addressEmail(body.from);
  const sender = normalizeRecipient(fromAddr);
  const alias = await env.DB.prepare(
    "SELECT * FROM aliases WHERE alias = ? AND domain = ?"
  ).bind(sender.alias, sender.domain).first<AliasRow>();
  if (alias?.status === "blocked") return apiError("bad_request", "sender alias is blocked", 400);

  const recipients = dedupeRecipients(body);
  const now = Date.now();
  const r2Key = `sent/${encodeURIComponent(sender.domain)}/${encodeURIComponent(sender.alias)}/${body.id}.json`;
  try {
    await env.DB.batch([
      ...(!alias ? [env.DB.prepare(`
        INSERT INTO aliases (alias, domain, status, note, forward_to, first_seen_at, last_seen_at, email_count)
        VALUES (?, ?, 'active', NULL, NULL, ?, ?, 0)
        ON CONFLICT(alias, domain) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).bind(sender.alias, sender.domain, now, now)] : []),
      env.DB.prepare(`
        INSERT INTO sent_emails (
          id, alias, domain, from_addr, subject, created_at, updated_at, status,
          message_id, error_code, error_message, recipient_count, r2_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitting', NULL, NULL, NULL, ?, ?)
      `).bind(
        body.id, sender.alias, sender.domain, fromAddr, body.subject,
        now, now, recipients.length, r2Key
      ),
      ...recipients.map((recipient) => env.DB.prepare(`
        INSERT INTO sent_recipients (sent_id, email, kind, status, updated_at, detail)
        VALUES (?, ?, ?, 'submitting', 0, NULL)
      `).bind(body.id, recipient.email, recipient.kind))
    ]);
  } catch (error) {
    const duplicate = await env.DB.prepare(
      "SELECT * FROM sent_emails WHERE id = ?"
    ).bind(body.id).first<SentEmailRow>();
    if (duplicate) return existingSendResponse(duplicate, env);
    throw error;
  }

  try {
    await env.RAW.put(r2Key, new TextEncoder().encode(JSON.stringify(body)).buffer, {
      httpMetadata: { contentType: "application/json" }
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM sent_recipients WHERE sent_id = ?").bind(body.id).run();
    await env.DB.prepare("DELETE FROM sent_emails WHERE id = ?").bind(body.id).run();
    throw error;
  }

  const providerMessage = providerPayload(body, recipients);
  let result: { messageId: string };
  try {
    result = await env.EMAIL.send(providerMessage);
  } catch (error) {
    const message = errorMessage(error);
    const code = errorCode(error);
    const failedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE sent_emails
        SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).bind(code, message, failedAt, body.id),
      env.DB.prepare(`
        UPDATE sent_recipients
        SET status = 'failed', updated_at = ?, detail = ?
        WHERE sent_id = ?
      `).bind(failedAt, message, body.id)
    ]);
    return apiError("internal", `send ${body.id} failed: ${message}`, 502);
  }
  const acceptedAt = Date.now();
  try {
    await env.DB.prepare(`
      UPDATE sent_emails
      SET status = 'accepted', message_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(result.messageId, acceptedAt, body.id).run();
    await env.DB.prepare(`
      UPDATE sent_recipients
      SET status = 'accepted', updated_at = ?, detail = NULL
      WHERE sent_id = ?
    `).bind(acceptedAt, body.id).run();
    return json(await findSentEmail(body.id, env), 201);
  } catch (error) {
    console.error(
      `failed to persist send ${body.id} after provider message ${result.messageId}`,
      error
    );
    return unknownSendOutcome(body.id);
  }
}

async function existingSendResponse(row: SentEmailRow, env: Env) {
  return row.status === "submitting"
    ? unknownSendOutcome(row.id)
    : json(await sentEmail(row, env));
}

function unknownSendOutcome(id: string) {
  return apiError(
    "internal",
    `send ${id} outcome is unknown; it must not be resent under a new id`,
    503
  );
}

async function listSentEmails(url: URL, env: Env) {
  const limit = boundedInt(url.searchParams.get("limit"), 20, 100);
  if (!limit) return apiError("bad_request", "limit must be an integer between 1 and 100", 400);
  const rows = (await env.DB.prepare(`
    SELECT s.* FROM sent_emails s
    WHERE (? IS NULL OR s.alias = ?)
      AND (? IS NULL OR s.domain = ?)
      AND (? IS NULL OR s.status = ?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM sent_recipients r
        WHERE r.sent_id = s.id AND lower(r.email) = lower(?)
      ))
      AND (? IS NULL OR (s.created_at, s.id) < (
        SELECT created_at, id FROM sent_emails WHERE id = ?
      ))
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ?
  `).bind(
    valueOrNull(url.searchParams.get("alias")), valueOrNull(url.searchParams.get("alias")),
    lowerOrNull(url.searchParams.get("domain")), lowerOrNull(url.searchParams.get("domain")),
    valueOrNull(url.searchParams.get("status")), valueOrNull(url.searchParams.get("status")),
    valueOrNull(url.searchParams.get("to")), valueOrNull(url.searchParams.get("to")),
    valueOrNull(url.searchParams.get("cursor")), valueOrNull(url.searchParams.get("cursor")),
    limit
  ).all<SentEmailRow>()).results;
  return json({ emails: rows.map(mapSentEmailRow), cursor: rows.at(-1)?.id ?? null });
}

async function getSentEmail(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM sent_emails WHERE id = ?").bind(id).first<SentEmailRow>();
  if (!row) return apiError("not_found", "sent email not found", 404);
  return json(await sentEmail(row, env));
}

async function findSentEmail(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM sent_emails WHERE id = ?").bind(id).first<SentEmailRow>();
  if (!row) throw new Error("sent email disappeared");
  return sentEmail(row, env);
}

async function sentEmail(row: SentEmailRow, env: Env) {
  const recipients = (await env.DB.prepare(`
    SELECT * FROM sent_recipients
    WHERE sent_id = ?
    ORDER BY CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END, rowid
  `).bind(row.id).all<SentRecipientRow>()).results;
  return { ...mapSentEmailRow(row), recipients: recipients.map(mapSentRecipientRow) };
}

async function getSentPayload(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM sent_emails WHERE id = ?").bind(id).first<SentEmailRow>();
  if (!row) return apiError("not_found", "sent email not found", 404);
  const object = await env.RAW.get(row.r2_key);
  if (!object) return apiError("not_found", "sent payload not found", 404);
  return new Response(object.body, { headers: { "Content-Type": "application/json" } });
}

async function deleteSentEmail(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM sent_emails WHERE id = ?").bind(id).first<SentEmailRow>();
  if (!row) return apiError("not_found", "sent email not found", 404);
  await env.RAW.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM sent_recipients WHERE sent_id = ?").bind(id).run();
  const result = await env.DB.prepare("DELETE FROM sent_emails WHERE id = ?").bind(id).run();
  return json({ deleted: result.meta.changes ?? 0 });
}

async function deleteSentEmailsByAlias(url: URL, env: Env) {
  const alias = valueOrNull(url.searchParams.get("alias"));
  const domain = lowerOrNull(url.searchParams.get("domain"));
  if (!alias || !domain) return apiError("bad_request", "alias and domain are required", 400);
  const prefix = `sent/${encodeURIComponent(domain)}/${encodeURIComponent(alias)}/`;
  for (;;) {
    const listed = await env.RAW.list({ prefix });
    await Promise.all(listed.objects.map((object) => env.RAW.delete(object.key)));
    if (!listed.truncated) break;
  }
  await env.DB.prepare(`
    DELETE FROM sent_recipients
    WHERE sent_id IN (SELECT id FROM sent_emails WHERE alias = ? AND domain = ?)
  `).bind(alias, domain).run();
  const result = await env.DB.prepare(
    "DELETE FROM sent_emails WHERE alias = ? AND domain = ?"
  ).bind(alias, domain).run();
  return json({ deleted: result.meta.changes ?? 0 });
}

async function replyToEmail(id: string, request: Request, env: Env) {
  const body = await request.json().catch(() => null);
  const validationError = validateReplyRequest(body);
  if (validationError) return apiError("bad_request", validationError, 400);
  const reply = body as ReplyEmailRequest;
  const original = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first<EmailRow>();
  if (!original) return apiError("not_found", "email not found", 404);

  const replyTo = parseAddressList(original.reply_to)[0] ?? original.from_addr;
  const own = original.to_addr.toLowerCase();
  const primary = addressEmail(replyTo).toLowerCase();
  const cc = dedupeAddressInputs([
    ...asAddressArray(reply.cc),
    ...(reply.replyAll ? [
      ...parseAddressList(original.to_header),
      ...parseAddressList(original.cc_header)
    ] : [])
  ]).filter((address) => {
    const email = addressEmail(address).toLowerCase();
    return email !== own && email !== primary;
  });
  const headers = { ...reply.headers };
  if (original.message_id) {
    headers["In-Reply-To"] = original.message_id;
    headers.References = [original.references_header, original.message_id].filter(Boolean).join(" ");
  }

  const quote = reply.quote !== false;
  const attribution = `On ${new Date(original.date_header ?? original.received_at).toUTCString()}, ${
    original.from_name ? `${original.from_name} <${original.from_addr}>` : original.from_addr
  } wrote:`;
  const text = quote && original.text_body && (reply.text !== undefined || reply.html === undefined)
    ? append(reply.text, `${attribution}\n> ${original.text_body.replace(/\n/g, "\n> ")}`)
    : reply.text;
  const quotedHtml = original.html_body
    ? `<div>${escapeHtml(attribution)}</div>\n<blockquote>${original.html_body}</blockquote>`
    : original.text_body
      ? `<div>${escapeHtml(attribution)}</div>\n<blockquote>${escapeHtml(original.text_body).replace(/\n/g, "<br>")}</blockquote>`
      : undefined;
  const replyHtml = reply.html ?? (quote && reply.text !== undefined && quotedHtml
    ? `<div>${escapeHtml(reply.text).replace(/\n/g, "<br>")}</div>`
    : undefined);
  const html = quote && quotedHtml ? (replyHtml ? `${replyHtml}\n${quotedHtml}` : quotedHtml) : replyHtml;
  const derived: SendEmailRequest = {
    version: 1,
    id: reply.id,
    from: original.to_addr,
    to: replyTo,
    subject: /^re:/i.test(original.subject ?? "") ? original.subject! : `Re: ${original.subject ?? ""}`,
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(cc.length ? { cc } : {}),
    ...(reply.bcc !== undefined ? { bcc: reply.bcc } : {}),
    ...(reply.attachments ? { attachments: reply.attachments } : {}),
    ...(Object.keys(headers).length ? { headers } : {})
  };
  return sendEmail(derived, env);
}

export async function handleDeliveryEvents(batch: QueueBatch<unknown>, env: Env) {
  for (const message of batch.messages) {
    const event = parseDeliveryEvent(message.body);
    if (!event) continue;
    const sent = await env.DB.prepare(
      "SELECT * FROM sent_emails WHERE message_id = ?"
    ).bind(event.messageId).first<SentEmailRow>();
    if (!sent) continue;
    const recipient = await env.DB.prepare(`
      SELECT * FROM sent_recipients
      WHERE sent_id = ? AND lower(email) = lower(?)
    `).bind(sent.id, event.recipient).first<SentRecipientRow>();
    if (!recipient ||
      !["accepted", "submitting"].includes(recipient.status) && event.timestamp <= recipient.updated_at) continue;
    await env.DB.prepare(`
      UPDATE sent_recipients
      SET status = ?, updated_at = ?, detail = ?
      WHERE sent_id = ? AND lower(email) = lower(?)
    `).bind(event.event, event.timestamp, event.detail, sent.id, event.recipient).run();
    const recipients = (await env.DB.prepare(
      "SELECT * FROM sent_recipients WHERE sent_id = ?"
    ).bind(sent.id).all<SentRecipientRow>()).results;
    const statuses = new Set(recipients.map((row) => row.status));
    await env.DB.prepare(`
      UPDATE sent_emails SET status = ?, updated_at = ? WHERE id = ?
    `).bind(
      statuses.size === 1 ? recipients[0]!.status : "partial",
      Math.max(sent.updated_at, event.timestamp),
      sent.id
    ).run();
  }
}

async function listEmails(url: URL, env: Env) {
  const limit = boundedInt(url.searchParams.get("limit"), 20, 100);
  if (!limit) return apiError("bad_request", "limit must be an integer between 1 and 100", 400);

  const includeBody = url.searchParams.get("include") === "body";
  const since = parseOptionalInt(url.searchParams.get("since"));
  if (since === false) return apiError("bad_request", "since must be a unix millisecond integer", 400);

  const rows = (await env.DB.prepare(`
    SELECT * FROM emails
    WHERE (? IS NULL OR alias = ?)
      AND (? IS NULL OR domain = ?)
      AND (? IS NULL OR lower(from_addr) LIKE '%' || lower(?) || '%' OR lower(coalesce(from_name, '')) LIKE '%' || lower(?) || '%')
      AND (? IS NULL OR id >= ?)
      AND (? IS NULL OR id < ?)
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    valueOrNull(url.searchParams.get("alias")), valueOrNull(url.searchParams.get("alias")),
    lowerOrNull(url.searchParams.get("domain")), lowerOrNull(url.searchParams.get("domain")),
    valueOrNull(url.searchParams.get("from")), valueOrNull(url.searchParams.get("from")), valueOrNull(url.searchParams.get("from")),
    since === null ? null : ulidFloor(since), since === null ? null : ulidFloor(since),
    valueOrNull(url.searchParams.get("cursor")), valueOrNull(url.searchParams.get("cursor")),
    limit
  ).all<EmailRow>()).results;

  const emails = rows.map((row) => mapEmailRow(row, includeBody as true));
  return json({ emails, cursor: rows.at(-1)?.id ?? null });
}

async function getEmail(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first<EmailRow>();
  if (!row) return apiError("not_found", "email not found", 404);
  return json(mapEmailRow(row, true));
}

async function getRawEmail(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first<EmailRow>();
  if (!row) return apiError("not_found", "email not found", 404);
  const object = await env.RAW.get(row.r2_key);
  if (!object) return apiError("not_found", "raw email not found", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${id}.eml"`
    }
  });
}

async function deleteEmail(id: string, env: Env) {
  const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first<EmailRow>();
  if (!row) return apiError("not_found", "email not found", 404);
  await env.RAW.delete(row.r2_key);
  const result = await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
  return json({ deleted: result.meta.changes ?? 0 });
}

async function deleteEmailsByAlias(url: URL, env: Env) {
  const alias = valueOrNull(url.searchParams.get("alias"));
  const domain = lowerOrNull(url.searchParams.get("domain"));
  if (!alias || !domain) return apiError("bad_request", "alias and domain are required", 400);

  const prefix = `${domain}/${alias}/`;
  for (;;) {
    const listed = await env.RAW.list({ prefix });
    await Promise.all(listed.objects.map((object) => env.RAW.delete(object.key)));
    if (!listed.truncated) break;
  }

  const result = await env.DB.prepare("DELETE FROM emails WHERE alias = ? AND domain = ?").bind(alias, domain).run();
  return json({ deleted: result.meta.changes ?? 0 });
}

async function listAliases(url: URL, env: Env) {
  const limit = boundedInt(url.searchParams.get("limit"), 50, 200);
  if (!limit) return apiError("bad_request", "limit must be an integer between 1 and 200", 400);

  const rows = (await env.DB.prepare(`
    SELECT * FROM aliases
    WHERE (? IS NULL OR lower(alias) LIKE '%' || lower(?) || '%')
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR domain = ?)
      AND (? IS NULL OR forward_to IS NOT NULL)
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).bind(
    valueOrNull(url.searchParams.get("q")), valueOrNull(url.searchParams.get("q")),
    valueOrNull(url.searchParams.get("status")), valueOrNull(url.searchParams.get("status")),
    lowerOrNull(url.searchParams.get("domain")), lowerOrNull(url.searchParams.get("domain")),
    url.searchParams.get("routed") === "true" ? true : null,
    limit
  ).all<AliasRow>()).results;

  return json({ aliases: rows.map(mapAliasRow) });
}

async function patchAlias(domainParam: string, aliasParam: string, request: Request, env: Env) {
  const domain = decodeURIComponent(domainParam).toLowerCase();
  const alias = normalizePathAlias(aliasParam);
  if (alias.includes("+")) return apiError("bad_request", "alias path must not contain +", 400);

  const body = await request.json() as { status?: unknown; note?: unknown; forwardTo?: unknown };
  if (body.status !== undefined && body.status !== "active" && body.status !== "blocked") {
    return apiError("bad_request", "status must be active or blocked", 400);
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return apiError("bad_request", "note must be a string or null", 400);
  }
  if (body.forwardTo !== undefined && body.forwardTo !== null && (typeof body.forwardTo !== "string" || !isForwardTo(body.forwardTo.trim()))) {
    return apiError("bad_request", "forwardTo must be an email address or null", 400);
  }
  const existing = await env.DB.prepare(
    "SELECT * FROM aliases WHERE alias = ? AND domain = ?"
  ).bind(alias, domain).first<AliasRow>();
  const status = body.status === undefined ? existing?.status ?? "active" : body.status;
  const note = body.note === undefined ? existing?.note ?? null : body.note;
  const forwardTo = body.forwardTo === undefined ? existing?.forward_to ?? null : body.forwardTo === null ? null : body.forwardTo.trim();

  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO aliases (alias, domain, status, note, forward_to, first_seen_at, last_seen_at, email_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(alias, domain) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      forward_to = excluded.forward_to,
      last_seen_at = excluded.last_seen_at
  `).bind(alias, domain, status, note, forwardTo, now, now).run();

  const row = await env.DB.prepare(
    "SELECT * FROM aliases WHERE alias = ? AND domain = ?"
  ).bind(alias, domain).first<AliasRow>();
  return json(mapAliasRow(row!));
}

function isForwardTo(value: string) {
  if (!value || value.length > 90 || /\s/.test(value)) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

function validateSendRequest(value: unknown) {
  if (!isRecord(value)) return "request body must be an object";
  if (value.version !== 1) return "version must be 1";
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) return "id is invalid";
  if (!isAddress(value.from)) return "from must be a valid email address";
  if (!isAddressField(value.to, true)) return "to must contain a valid email address";
  if (typeof value.subject !== "string" ||
    value.subject.length > MAX_SUBJECT_LENGTH ||
    hasHeaderBreak(value.subject)) return "subject is invalid";
  if (value.text !== undefined && typeof value.text !== "string") return "text must be a string";
  if (value.html !== undefined && typeof value.html !== "string") return "html must be a string";
  if (value.cc !== undefined && !isAddressField(value.cc)) return "cc must contain valid email addresses";
  if (value.bcc !== undefined && !isAddressField(value.bcc)) return "bcc must contain valid email addresses";
  if (value.replyTo !== undefined && !isAddress(value.replyTo)) return "replyTo must be a valid email address";
  if (!validAttachments(value.attachments)) return "attachments are invalid";
  if (!validHeaders(value.headers)) return "headers must contain string values";
  if (dedupeRecipients(value as unknown as SendEmailRequest).length > MAX_RECIPIENTS) {
    return `at most ${MAX_RECIPIENTS} recipients are allowed`;
  }
  return null;
}

function validateReplyRequest(value: unknown) {
  if (!isRecord(value)) return "request body must be an object";
  if (value.version !== 1) return "version must be 1";
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) return "id is invalid";
  if (value.text !== undefined && typeof value.text !== "string") return "text must be a string";
  if (value.html !== undefined && typeof value.html !== "string") return "html must be a string";
  if (value.cc !== undefined && !isAddressField(value.cc)) return "cc must contain valid email addresses";
  if (value.bcc !== undefined && !isAddressField(value.bcc)) return "bcc must contain valid email addresses";
  if (!validAttachments(value.attachments)) return "attachments are invalid";
  if (!validHeaders(value.headers)) return "headers must contain string values";
  if (value.replyAll !== undefined && typeof value.replyAll !== "boolean") return "replyAll must be a boolean";
  if (value.quote !== undefined && typeof value.quote !== "boolean") return "quote must be a boolean";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is EmailAddressInput {
  if (typeof value === "string") return isEmail(value);
  return isRecord(value) &&
    typeof value.email === "string" &&
    isEmail(value.email) &&
    (value.name === undefined || typeof value.name === "string" && !hasHeaderBreak(value.name));
}

function isAddressField(value: unknown, required = false) {
  if (Array.isArray(value)) return (!required || value.length > 0) && value.length > 0 && value.every(isAddress);
  return isAddress(value);
}

function isEmail(value: string) {
  if (!value || value.length > 320 || /\s/.test(value)) return false;
  const at = value.lastIndexOf("@");
  return at > 0 && at === value.indexOf("@") && at < value.length - 1;
}

function validAttachments(value: unknown) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every((attachment) =>
    isRecord(attachment) &&
    typeof attachment.content === "string" &&
    typeof attachment.filename === "string" &&
    typeof attachment.type === "string" &&
    (attachment.disposition === "attachment" ||
      (attachment.disposition === "inline" && typeof attachment.contentId === "string"))
  );
}

function validHeaders(value: unknown) {
  return value === undefined || isRecord(value) && Object.entries(value).every(([name, header]) =>
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) &&
    typeof header === "string" &&
    !hasHeaderBreak(header)
  );
}

function hasHeaderBreak(value: string) {
  return /[\r\n]/.test(value);
}

function addressEmail(address: EmailAddressInput) {
  return typeof address === "string" ? address : address.email;
}

function asAddressArray(value: EmailAddressInput | EmailAddressInput[] | undefined) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function dedupeAddressInputs(addresses: EmailAddressInput[]) {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const email = addressEmail(address).toLowerCase();
    if (seen.has(email)) return false;
    seen.add(email);
    return true;
  });
}

function dedupeRecipients(body: SendEmailRequest) {
  const seen = new Set<string>();
  const recipients: { email: string; address: EmailAddressInput; kind: "to" | "cc" | "bcc" }[] = [];
  for (const [kind, values] of [
    ["to", asAddressArray(body.to)],
    ["cc", asAddressArray(body.cc)],
    ["bcc", asAddressArray(body.bcc)]
  ] as const) {
    for (const address of values) {
      const email = addressEmail(address);
      if (seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      recipients.push({ email, address, kind });
    }
  }
  return recipients;
}

function providerPayload(
  body: SendEmailRequest,
  recipients: ReturnType<typeof dedupeRecipients>
) {
  const byKind = (kind: "to" | "cc" | "bcc") =>
    recipients.filter((recipient) => recipient.kind === kind).map((recipient) => providerAddress(recipient.address));
  const to = byKind("to");
  const cc = byKind("cc");
  const bcc = byKind("bcc");
  return {
    from: providerAddress(body.from),
    to: oneOrMany(to),
    subject: body.subject,
    ...(body.text !== undefined ? { text: body.text } : {}),
    ...(body.html !== undefined ? { html: body.html } : {}),
    ...(cc.length ? { cc: oneOrMany(cc) } : {}),
    ...(bcc.length ? { bcc: oneOrMany(bcc) } : {}),
    ...(body.replyTo !== undefined ? { replyTo: providerAddress(body.replyTo) } : {}),
    ...(body.attachments ? { attachments: body.attachments } : {}),
    ...(body.headers ? { headers: body.headers } : {})
  };
}

function providerAddress(address: EmailAddressInput) {
  return typeof address === "string" || !address.name
    ? addressEmail(address)
    : { email: address.email, name: address.name };
}

function oneOrMany(addresses: ReturnType<typeof providerAddress>[]) {
  return addresses.length === 1 ? addresses[0]! : addresses;
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, ERROR_LIMIT);
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code.slice(0, 100) : null;
}

function parseAddressList(value: string | null | undefined): EmailAddressInput[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isAddress) : [];
  } catch {
    return [];
  }
}

function append(value: string | undefined, addition: string) {
  return value ? `${value}\n\n${addition}` : addition;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  })[character]!);
}

function parseDeliveryEvent(value: unknown) {
  if (!isRecord(value) ||
    typeof value.type !== "string" ||
    !value.type.startsWith(DELIVERY_EVENT_PREFIX)) return null;
  const event = value.type.slice(DELIVERY_EVENT_PREFIX.length);
  const payload = value.payload;
  const metadata = value.metadata;
  if (!DELIVERY_EVENTS.has(event) ||
    !isRecord(payload) ||
    typeof payload.eventId !== "string" ||
    typeof payload.messageId !== "string" ||
    typeof payload.recipient !== "string" ||
    !isRecord(metadata) ||
    typeof metadata.eventTimestamp !== "string") return null;
  const timestamp = Date.parse(metadata.eventTimestamp);
  if (!Number.isFinite(timestamp)) return null;
  const nestedKey = ({
    delivered: "delivery",
    deferred: "delivery",
    bounced: "bounce",
    failed: "failure",
    rejected: "rejection",
    complained: "complaint"
  } as const)[event as "delivered"];
  const nested = payload[nestedKey];
  return {
    eventId: payload.eventId,
    messageId: payload.messageId,
    recipient: payload.recipient,
    event,
    timestamp,
    detail: isRecord(nested)
      ? ["detail", "reason", "smtpResponse", "classification", "type", "status"]
        .map((key) => nested[key])
        .find((detail): detail is string => typeof detail === "string")
        ?.slice(0, ERROR_LIMIT) ?? null
      : null
  };
}

function valueOrNull(value: string | null) {
  return value === null || value === "" ? null : value;
}

function lowerOrNull(value: string | null) {
  return valueOrNull(value)?.toLowerCase() ?? null;
}

function parseOptionalInt(value: string | null) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : false;
}

function boundedInt(value: string | null, fallback: number, max: number) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}
