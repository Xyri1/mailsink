import { apiError, json, mapAliasRow, mapEmailRow, normalizePathAlias, ulidFloor } from "./core";
import { isAuthorized } from "./auth";
import type { AliasRow, EmailRow, Env } from "./types";

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
