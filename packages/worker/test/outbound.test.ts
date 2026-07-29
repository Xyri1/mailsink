import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { makeEnv } from "./fakes";

let env: ReturnType<typeof makeEnv>;
let sent: Parameters<Env["EMAIL"]["send"]>[0][];

beforeEach(() => {
  env = makeEnv();
  sent = [];
  env.DB.aliases.set(env.DB.aliasKey("existing", "example.com"), {
    alias: "existing", domain: "example.com", status: "active", note: null,
    forward_to: null, first_seen_at: 0, last_seen_at: 0, email_count: 0
  });
  env.EMAIL = {
    async send(message) {
      sent.push(message);
      return { messageId: "cf-message-1" };
    }
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-token");
  headers.set("Content-Type", "application/json");
  return new Request(`https://sink.example.com${path}`, { ...init, headers });
}

function sendBody(id = "send-1") {
  return {
    version: 1,
    id,
    from: { email: "Sender@Example.COM", name: "Sender" },
    to: ["one@example.net", { email: "TWO@example.net", name: "Two" }],
    cc: ["one@example.net", "copy@example.net"],
    bcc: "copy@example.net",
    subject: "Hello",
    text: "Body"
  };
}

function seedReplySource(id = "inbound-alternative", htmlBody: string | null = "<p>Original HTML</p>") {
  env.DB.emails.set(id, {
    id,
    alias: "support",
    domain: "example.com",
    to_addr: "support@example.com",
    envelope_from: "bounce@customer.test",
    from_addr: "customer@customer.test",
    from_name: "Customer",
    subject: "Need help",
    date_header: Date.UTC(2026, 5, 12, 8),
    received_at: Date.UTC(2026, 5, 12, 8),
    size_bytes: 1,
    text_body: "Original text",
    html_body: htmlBody,
    has_html: htmlBody ? 1 : 0,
    attachment_count: 0,
    parse_error: 0,
    r2_key: `example.com/support/${id}.eml`,
    forward_to: null,
    forward_error: null,
    message_id: "<original@customer.test>",
    reply_to: JSON.stringify([{ email: "reply@customer.test" }]),
    to_header: JSON.stringify(["support@example.com"]),
    cc_header: null,
    references_header: null
  });
}

describe("outbound email API", () => {
  test("archives before one provider call, creates the sender alias, and deduplicates recipients", async () => {
    env.EMAIL.send = async (message) => {
      expect([...env.RAW.objects.keys()]).toEqual(["sent/example.com/sender/send-1.json"]);
      expect(env.DB.sentEmails.has("send-1")).toBe(true);
      sent.push(message);
      return { messageId: "cf-message-1" };
    };

    const response = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody())
    }), env);

    expect(response.status).toBe(201);
    expect(await response.json() as unknown).toMatchObject({
      id: "send-1",
      alias: "sender",
      domain: "example.com",
      fromAddr: "Sender@Example.COM",
      status: "accepted",
      messageId: "cf-message-1",
      recipientCount: 3,
      recipients: [
        { email: "one@example.net", kind: "to", status: "accepted" },
        { email: "TWO@example.net", kind: "to", status: "accepted" },
        { email: "copy@example.net", kind: "cc", status: "accepted" }
      ]
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: { email: "Sender@Example.COM", name: "Sender" }, subject: "Hello" });
    expect(env.DB.aliases.has(env.DB.aliasKey("sender", "example.com"))).toBe(true);
  });

  test("submits an unseen alias on a domain with no existing alias rows", async () => {
    env.DB.aliases.clear();

    const response = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify({ ...sendBody("new-domain"), from: "first@brand-new.test" })
    }), env);

    expect(response.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "first@brand-new.test" });
    expect(env.DB.aliases.has(env.DB.aliasKey("first", "brand-new.test"))).toBe(true);
  });

  test("returns an existing id without submitting twice", async () => {
    const first = () => worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody("same-id"))
    }), env);

    expect((await first()).status).toBe(201);
    expect((await first()).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test("returns the uncertainty warning when another request wins the id insert race", async () => {
    env.DB.beforeBatch = () => {
      env.DB.sentEmails.set("raced-id", {
        id: "raced-id",
        alias: "sender",
        domain: "example.com",
        from_addr: "sender@example.com",
        subject: "Hello",
        created_at: 1,
        updated_at: 1,
        status: "submitting",
        message_id: null,
        error_code: null,
        error_message: null,
        recipient_count: 1,
        r2_key: "sent/example.com/sender/raced-id.json"
      });
    };

    const response = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody("raced-id"))
    }), env);

    expect(response.status).toBe(503);
    expect(await response.json() as unknown).toMatchObject({
      error: { message: "send raced-id outcome is unknown; it must not be resent under a new id" }
    });
    expect(sent).toHaveLength(0);
  });

  test("encodes sender path segments so purging a parent alias cannot delete another payload", async () => {
    await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify({ ...sendBody("team-id"), from: "dept/team@example.com" })
    }), env);
    await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify({ ...sendBody("dept-id"), from: "dept@example.com" })
    }), env);

    expect([...env.RAW.objects.keys()]).toContain("sent/example.com/dept%2Fteam/team-id.json");
    await worker.fetch(request("/v1/sent?alias=dept&domain=example.com", { method: "DELETE" }), env);
    expect((await worker.fetch(request("/v1/sent/team-id/payload"), env)).status).toBe(200);
    expect((await worker.fetch(request("/v1/sent/dept-id"), env)).status).toBe(404);
  });

  test("does not archive malformed local input", async () => {
    const response = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify({ ...sendBody("bad-id"), to: "not-an-address" })
    }), env);

    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(env.DB.sentEmails.size).toBe(0);
    expect(env.RAW.objects.size).toBe(0);
  });

  test("rejects blocked senders and persists provider failures", async () => {
    env.DB.aliases.set(env.DB.aliasKey("blocked", "example.com"), {
      alias: "blocked", domain: "example.com", status: "blocked", note: null,
      forward_to: null, first_seen_at: 0, last_seen_at: 0, email_count: 0
    });
    const blocked = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify({ ...sendBody("blocked-id"), from: "blocked@example.com" })
    }), env);
    expect(blocked.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect([...env.RAW.objects.keys()]).toHaveLength(0);

    env.EMAIL.send = async () => {
      throw Object.assign(new Error("provider unavailable"), { code: "temporary" });
    };
    const failed = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody("failed-id"))
    }), env);
    expect(failed.status).toBe(502);
    expect(await failed.json() as unknown).toEqual({
      error: {
        code: "internal",
        message: "send failed-id failed: provider unavailable"
      }
    });

    const stored = await worker.fetch(request("/v1/sent/failed-id"), env);
    const failureBody = await stored.json() as {
      status: string;
      recipients: { status: string; detail: string | null }[];
    };
    expect(failureBody).toMatchObject({
      id: "failed-id",
      status: "failed",
      errorCode: "temporary",
      errorMessage: "provider unavailable"
    });
    expect(failureBody.recipients.every((recipient) =>
      recipient.status === "failed" && recipient.detail === "provider unavailable"
    )).toBe(true);
    expect((await worker.fetch(request("/v1/sent/failed-id/payload"), env)).status).toBe(200);
    expect([...env.RAW.objects.keys()]).toContain("sent/example.com/sender/failed-id.json");
  });

  test("does not resend when provider acceptance cannot be persisted", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    env.DB.failOnSql = "SET status = 'accepted', message_id";

    const submit = () => worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody("uncertain-id"))
    }), env);
    const response = await submit();

    expect(response.status).toBe(503);
    expect(await response.json() as unknown).toEqual({
      error: {
        code: "internal",
        message: "send uncertain-id outcome is unknown; it must not be resent under a new id"
      }
    });
    expect(env.DB.sentEmails.get("uncertain-id")).toMatchObject({ status: "submitting", message_id: null });
    expect([...env.RAW.objects.keys()]).toContain("sent/example.com/sender/uncertain-id.json");
    expect(sent).toHaveLength(1);
    expect(errorLog.mock.calls.flat().join(" ")).toContain("uncertain-id");
    expect(errorLog.mock.calls.flat().join(" ")).toContain("cf-message-1");

    env.DB.failOnSql = null;
    expect((await submit()).status).toBe(503);
    expect(sent).toHaveLength(1);
  });

  test("persists provider identity before a recipient-status write failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.DB.failOnSql = "UPDATE sent_recipients";

    const response = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody("recipient-write-failure"))
    }), env);

    expect(response.status).toBe(503);
    expect(env.DB.sentEmails.get("recipient-write-failure")).toMatchObject({
      status: "accepted",
      message_id: "cf-message-1"
    });
    expect(sent).toHaveLength(1);
  });

  test("derives a quoted reply and reply-all recipients from stored inbound metadata", async () => {
    env.DB.emails.set("inbound-1", {
      id: "inbound-1",
      alias: "support",
      domain: "example.com",
      to_addr: "Support+case@Example.COM",
      envelope_from: "bounce@customer.test",
      from_addr: "customer@customer.test",
      from_name: "Customer & Co",
      subject: "Need help",
      date_header: null,
      received_at: Date.UTC(2026, 5, 12, 8),
      size_bytes: 1,
      text_body: "Original line",
      html_body: "<p>Original line</p>",
      has_html: 1,
      attachment_count: 0,
      parse_error: 0,
      r2_key: "example.com/support/inbound-1.eml",
      forward_to: null,
      forward_error: null,
      message_id: "<original@customer.test>",
      reply_to: JSON.stringify([{ email: "reply@customer.test", name: "Replies" }]),
      to_header: JSON.stringify(["Support+case@Example.COM", "team@example.com"]),
      cc_header: JSON.stringify(["watcher@example.net", "support+case@example.com"]),
      references_header: "<older@customer.test>"
    });

    const response = await worker.fetch(request("/v1/emails/inbound-1/reply", {
      method: "POST",
      body: JSON.stringify({ version: 1, id: "reply-1", text: "Answer", html: "<p>Answer</p>", replyAll: true })
    }), env);

    expect(response.status).toBe(201);
    expect(sent[0]).toMatchObject({
      from: "Support+case@Example.COM",
      to: { email: "reply@customer.test", name: "Replies" },
      cc: ["team@example.com", "watcher@example.net"],
      subject: "Re: Need help",
      text: "Answer\n\nOn Fri, 12 Jun 2026 08:00:00 GMT, Customer & Co <customer@customer.test> wrote:\n> Original line",
      html: "<p>Answer</p>\n<div>On Fri, 12 Jun 2026 08:00:00 GMT, Customer &amp; Co &lt;customer@customer.test&gt; wrote:</div>\n<blockquote><p>Original line</p></blockquote>",
      headers: {
        "In-Reply-To": "<original@customer.test>",
        References: "<older@customer.test> <original@customer.test>"
      }
    });
  });

  test("includes a text-only reply in the generated HTML alternative", async () => {
    seedReplySource();

    const response = await worker.fetch(request("/v1/emails/inbound-alternative/reply", {
      method: "POST",
      body: JSON.stringify({ version: 1, id: "text-only-reply", text: "Plain & answer" })
    }), env);

    expect(response.status).toBe(201);
    expect(sent[0]?.text).toContain("Plain & answer\n\nOn Fri, 12 Jun 2026 08:00:00 GMT");
    expect(sent[0]?.html).toBe(
      "<div>Plain &amp; answer</div>\n" +
      "<div>On Fri, 12 Jun 2026 08:00:00 GMT, Customer &lt;customer@customer.test&gt; wrote:</div>\n" +
      "<blockquote><p>Original HTML</p></blockquote>"
    );
  });

  test("includes a text reply when quoting a text-only original in generated HTML", async () => {
    seedReplySource("text-only-original", null);

    const response = await worker.fetch(request("/v1/emails/text-only-original/reply", {
      method: "POST",
      body: JSON.stringify({ version: 1, id: "text-to-text-reply", text: "Plain & answer" })
    }), env);

    expect(response.status).toBe(201);
    expect(sent[0]?.html).toBe(
      "<div>Plain &amp; answer</div>\n" +
      "<div>On Fri, 12 Jun 2026 08:00:00 GMT, Customer &lt;customer@customer.test&gt; wrote:</div>\n" +
      "<blockquote>Original text</blockquote>"
    );
  });

  test("does not create a quote-only text part for an HTML-only reply", async () => {
    seedReplySource();

    const response = await worker.fetch(request("/v1/emails/inbound-alternative/reply", {
      method: "POST",
      body: JSON.stringify({ version: 1, id: "html-only-reply", html: "<p>Rich answer</p>" })
    }), env);

    expect(response.status).toBe(201);
    expect(sent[0]).not.toHaveProperty("text");
    expect(sent[0]?.html).toContain("<p>Rich answer</p>\n<div>On Fri, 12 Jun 2026 08:00:00 GMT");
  });

  test("normalizes nameless address objects before provider submission", async () => {
    const response = await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify({
        ...sendBody("nameless-addresses"),
        from: { email: "sender@example.com" },
        to: { email: "one@example.net" },
        replyTo: { email: "replies@example.com" }
      })
    }), env);

    expect(response.status).toBe(201);
    expect(sent[0]).toMatchObject({
      from: "sender@example.com",
      to: "one@example.net",
      replyTo: "replies@example.com"
    });
  });

  test("updates matched recipient delivery status and ignores unmatched queue events", async () => {
    await worker.fetch(request("/v1/sent", {
      method: "POST",
      body: JSON.stringify(sendBody())
    }), env);

    const eventAt = Date.parse("2026-06-01T02:48:57.132Z");
    await worker.queue({
      messages: [
        { body: {
          type: "cf.email.sending.message.delivered",
          source: { type: "email.sending", zoneId: "zone-1", domain: "example.com" },
          payload: {
            eventId: "evt-1",
            messageId: "cf-message-1",
            sender: "Sender@Example.COM",
            recipient: "one@example.net",
            terminal: true,
            delivery: {
              status: "delivered",
              provider: "gmail",
              smtpStatusCode: "250",
              smtpResponse: "250 2.0.0 OK"
            }
          },
          metadata: { eventSchemaVersion: 1, eventTimestamp: "2026-06-01T02:48:57.132Z" }
        } },
        { body: {
          type: "cf.email.sending.message.deferred",
          payload: {
            eventId: "evt-old",
            messageId: "cf-message-1",
            recipient: "one@example.net",
            delivery: { status: "deferred", smtpResponse: "451 temporary" }
          },
          metadata: { eventTimestamp: "2026-05-31T02:48:57.132Z" }
        } },
        { body: {
          type: "cf.email.sending.message.bounced",
          payload: {
            eventId: "evt-2",
            messageId: "unknown",
            recipient: "nobody@example.net",
            bounce: { type: "hard", reason: "mailbox unavailable" }
          },
          metadata: { eventTimestamp: "2026-06-01T03:00:00.000Z" }
        } },
        { body: {
          type: "delivered",
          payload: {
            eventId: "evt-unprefixed",
            messageId: "cf-message-1",
            recipient: "TWO@example.net",
            delivery: { status: "delivered", smtpResponse: "250 should be ignored" }
          },
          metadata: { eventTimestamp: "2026-06-01T04:00:00.000Z" }
        } }
      ]
    }, env);

    const response = await worker.fetch(request("/v1/sent/send-1"), env);
    const result = await response.json() as {
      status: string;
      recipients: { email: string; status: string; updatedAt: number }[];
    };
    expect(result.status).toBe("partial");
    expect(result.recipients.find((recipient) => recipient.email === "one@example.net"))
      .toMatchObject({ status: "delivered", updatedAt: eventAt, detail: "250 2.0.0 OK" });
    expect(result.recipients.find((recipient) => recipient.email === "TWO@example.net"))
      .toMatchObject({ status: "accepted" });
  });

  test("lists, reads payload, deletes one, and bulk-purges by sender", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await worker.fetch(request("/v1/sent", { method: "POST", body: JSON.stringify(sendBody("z-old")) }), env);
    vi.setSystemTime(2_000);
    await worker.fetch(request("/v1/sent", { method: "POST", body: JSON.stringify(sendBody("a-new")) }), env);

    const list = await worker.fetch(request("/v1/sent?alias=sender&domain=example.com&to=copy@example.net&status=accepted&limit=1"), env);
    expect(await list.json() as unknown).toMatchObject({ emails: [{ id: "a-new", recipientCount: 3 }], cursor: "a-new" });
    const next = await worker.fetch(request("/v1/sent?limit=1&cursor=a-new"), env);
    expect(await next.json() as unknown).toMatchObject({ emails: [{ id: "z-old" }], cursor: "z-old" });

    const payload = await worker.fetch(request("/v1/sent/z-old/payload"), env);
    expect(await payload.json() as unknown).toEqual(sendBody("z-old"));

    expect(await (await worker.fetch(request("/v1/sent/z-old", { method: "DELETE" }), env)).json()).toEqual({ deleted: 1 });
    expect(await (await worker.fetch(request("/v1/sent?alias=sender&domain=example.com", { method: "DELETE" }), env)).json()).toEqual({ deleted: 1 });
    expect([...env.RAW.objects.keys()]).toHaveLength(0);
  });

  test("rejects oversized or header-injecting structured input before archival", async () => {
    const requests = [
      { ...sendBody("too-many"), to: Array.from({ length: 51 }, (_, index) => `user-${index}@example.net`) },
      { ...sendBody("too-many-files"), attachments: Array.from({ length: 33 }, (_, index) => ({
        content: "YQ==", filename: `${index}.txt`, type: "text/plain", disposition: "attachment"
      })) },
      { ...sendBody("long-subject"), subject: "x".repeat(999) },
      { ...sendBody("name-injection"), from: { email: "sender@example.com", name: "Sender\r\nBcc: victim@example.net" } },
      { ...sendBody("subject-injection"), subject: "Hello\r\nBcc: victim@example.net" },
      { ...sendBody("header-injection"), headers: { "X-Test": "ok\r\nBcc: victim@example.net" } }
    ];

    for (const body of requests) {
      const response = await worker.fetch(request("/v1/sent", { method: "POST", body: JSON.stringify(body) }), env);
      expect(response.status).toBe(400);
    }
    const reply = await worker.fetch(request("/v1/emails/unknown/reply", {
      method: "POST",
      body: JSON.stringify({
        version: 1,
        id: "reply-injection",
        text: "hello",
        headers: { "X-Test": "ok\nBcc: victim@example.net" }
      })
    }), env);
    expect(reply.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(env.DB.sentEmails.size).toBe(0);
    expect(env.RAW.objects.size).toBe(0);
  });
});
