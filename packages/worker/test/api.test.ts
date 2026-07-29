import { beforeEach, describe, expect, test } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fakes";

let env: ReturnType<typeof makeEnv>;

beforeEach(() => {
  env = makeEnv();
});

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-token");
  return new Request(`https://sink.example.com${path}`, { ...init, headers });
}

describe("API auth", () => {
  test("rejects missing bearer tokens with the shared error envelope", async () => {
    const response = await worker.fetch(new Request("https://sink.example.com/v1/emails"), env);

    expect(response.status).toBe(401);
    expect(await response.json() as unknown).toEqual({
      error: { code: "unauthorized", message: "missing or invalid bearer token" }
    });
  });
});

describe("alias API", () => {
  test("routes an unseen alias, lists routed aliases, and preserves omitted fields", async () => {
    const created = await worker.fetch(request("/v1/aliases/example.com/Netflix-X7F2", {
      method: "PATCH",
      body: JSON.stringify({ note: "netflix trial", forwardTo: " me@example.net " })
    }), env);
    expect(await created.json() as unknown).toMatchObject({
      alias: "netflix-x7f2", note: "netflix trial", forwardTo: "me@example.net", emailCount: 0
    });

    const routed = await worker.fetch(request("/v1/aliases?routed=true"), env);
    expect(await routed.json() as unknown).toMatchObject({ aliases: [{ alias: "netflix-x7f2", forwardTo: "me@example.net" }] });

    const cleared = await worker.fetch(request("/v1/aliases/example.com/netflix-x7f2", {
      method: "PATCH",
      body: JSON.stringify({ forwardTo: null })
    }), env);
    expect(await cleared.json() as unknown).toMatchObject({ note: "netflix trial", forwardTo: null });
  });

  test("rejects malformed forward destinations", async () => {
    const response = await worker.fetch(request("/v1/aliases/example.com/netflix", {
      method: "PATCH",
      body: JSON.stringify({ forwardTo: "two@@example.com" })
    }), env);
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toMatchObject({ error: { code: "bad_request" } });
  });

  test("pre-blocks an alias before first mail and rejects + aliases in the path", async () => {
    const blocked = await worker.fetch(request("/v1/aliases/example.com/Netflix-X7F2", {
      method: "PATCH",
      body: JSON.stringify({ status: "blocked", note: "netflix trial" })
    }), env);
    expect(blocked.status).toBe(200);
    expect(await blocked.json() as unknown).toMatchObject({
      alias: "netflix-x7f2",
      domain: "example.com",
      status: "blocked",
      note: "netflix trial",
      emailCount: 0
    });

    const bad = await worker.fetch(request("/v1/aliases/example.com/netflix+tag", {
      method: "PATCH",
      body: JSON.stringify({ status: "blocked" })
    }), env);
    expect(bad.status).toBe(400);
  });
});

describe("email API", () => {
  test("lists, reads raw, deletes one message, and preserves alias status after bulk purge", async () => {
    const now = 1781251200000;
    env.DB.emails.set("01K7VTNH010000000000000000", {
      id: "01K7VTNH010000000000000000",
      alias: "netflix-x7f2",
      domain: "example.com",
      to_addr: "netflix-x7f2@example.com",
      envelope_from: "bounce@em.netflix.com",
      from_addr: "no-reply@em.netflix.com",
      from_name: "Netflix",
      subject: "Your sign-in code",
      date_header: now,
      received_at: now,
      size_bytes: 20,
      text_body: "Your code is 123456.",
      has_html: 0,
      attachment_count: 0,
      parse_error: 0,
      r2_key: "example.com/netflix-x7f2/01K7VTNH010000000000000000.eml"
    });
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2",
      domain: "example.com",
      status: "blocked",
      note: "leaked",
      first_seen_at: now,
      last_seen_at: now,
      email_count: 1
    });
    await env.RAW.put("example.com/netflix-x7f2/01K7VTNH010000000000000000.eml", new TextEncoder().encode("raw message").buffer);

    const list = await worker.fetch(request("/v1/emails?alias=netflix-x7f2&domain=example.com&from=netflix&limit=1&include=body"), env);
    expect(list.status).toBe(200);
    expect(await list.json() as unknown).toMatchObject({
      emails: [{ id: "01K7VTNH010000000000000000", textBody: "Your code is 123456." }],
      cursor: "01K7VTNH010000000000000000"
    });

    const raw = await worker.fetch(request("/v1/emails/01K7VTNH010000000000000000/raw"), env);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("message/rfc822");
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toBe("raw message");

    const deleted = await worker.fetch(request("/v1/emails/01K7VTNH010000000000000000", { method: "DELETE" }), env);
    expect(deleted.status).toBe(200);
    expect(await deleted.json() as unknown).toEqual({ deleted: 1 });

    env.DB.emails.set("01K7VTNH020000000000000000", {
      id: "01K7VTNH020000000000000000",
      alias: "netflix-x7f2",
      domain: "example.com",
      r2_key: "example.com/netflix-x7f2/01K7VTNH020000000000000000.eml"
    });
    const purged = await worker.fetch(request("/v1/emails?alias=netflix-x7f2&domain=example.com", { method: "DELETE" }), env);
    expect(purged.status).toBe(200);
    expect(await purged.json() as unknown).toEqual({ deleted: 1 });
    expect(env.DB.aliases.get(env.DB.aliasKey("netflix-x7f2", "example.com"))?.status).toBe("blocked");
  });
});
