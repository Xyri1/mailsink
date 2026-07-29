import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createMessageBatch,
  type D1Migration
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type TestEnv = Env & {
  DB: D1Database;
  RAW: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
};

const testEnv = env as unknown as TestEnv;
const eventTime = "2026-06-01T02:48:57.132Z";

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM sent_recipients"),
    testEnv.DB.prepare("DELETE FROM sent_emails"),
    testEnv.DB.prepare("DELETE FROM emails"),
    testEnv.DB.prepare("DELETE FROM aliases")
  ]);
  for (;;) {
    const page = await testEnv.RAW.list();
    await Promise.all(page.objects.map(({ key }) => testEnv.RAW.delete(key)));
    if (!page.truncated) break;
  }
});

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer test-token");
  return new Request(`https://sink.example.com${path}`, { ...init, headers });
}

describe("Cloudflare local bindings", () => {
  test("runs the real migrations and deletes matching D1 and R2 data", async () => {
    const id = "01K7VTNH010000000000000000";
    const r2Key = `example.com/netflix-x7f2/${id}.eml`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO aliases (
          alias, domain, status, note, forward_to, first_seen_at, last_seen_at, email_count
        ) VALUES (?, ?, 'blocked', NULL, NULL, 1, 1, 1)
      `).bind("netflix-x7f2", "example.com"),
      testEnv.DB.prepare(`
        INSERT INTO emails (
          id, alias, domain, to_addr, envelope_from, from_addr, received_at, size_bytes, r2_key
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 11, ?)
      `).bind(
        id,
        "netflix-x7f2",
        "example.com",
        "netflix-x7f2@example.com",
        "bounce@example.net",
        "sender@example.net",
        r2Key
      )
    ]);
    await testEnv.RAW.put(r2Key, "raw message");

    const raw = await worker.fetch(request(`/v1/emails/${id}/raw`), testEnv);
    expect(raw.status).toBe(200);
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toBe("raw message");

    const deleted = await worker.fetch(request(
      "/v1/emails?alias=netflix-x7f2&domain=example.com",
      { method: "DELETE" }
    ), testEnv);
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(await testEnv.DB.prepare("SELECT id FROM emails WHERE id = ?").bind(id).first()).toBeNull();
    expect(await testEnv.RAW.get(r2Key)).toBeNull();
    expect(await testEnv.DB.prepare(
      "SELECT status FROM aliases WHERE alias = ? AND domain = ?"
    ).bind("netflix-x7f2", "example.com").first<{ status: string }>()).toEqual({
      status: "blocked"
    });
  });

  test("purges more than one R2 list page", { timeout: 30_000 }, async () => {
    const prefix = "example.com/paged/";
    await Promise.all(Array.from({ length: 1_001 }, (_, index) =>
      testEnv.RAW.put(`${prefix}${String(index).padStart(4, "0")}.eml`, "x")
    ));

    const deleted = await worker.fetch(request(
      "/v1/emails?alias=paged&domain=example.com",
      { method: "DELETE" }
    ), testEnv);

    expect(await deleted.json()).toEqual({ deleted: 0 });
    expect((await testEnv.RAW.list({ prefix })).objects).toHaveLength(0);
  });

  test("handles every documented Email Sending Queue event and ignores older duplicates", async () => {
    const events = [
      { status: "delivered", detail: "250 accepted", nested: { delivery: { smtpResponse: "250 accepted" } } },
      { status: "deferred", detail: "451 temporary", nested: { delivery: { smtpResponse: "451 temporary" } } },
      { status: "bounced", detail: "mailbox unavailable", nested: { bounce: { reason: "mailbox unavailable" } } },
      { status: "failed", detail: "delivery_failed", nested: { failure: { reason: "delivery_failed" } } },
      { status: "rejected", detail: "Recipient is suppressed", nested: { rejection: { detail: "Recipient is suppressed" } } },
      { status: "complained", detail: "abuse", nested: { complaint: { type: "abuse" } } }
    ] as const;
    await testEnv.DB.prepare(`
      INSERT INTO sent_emails (
        id, alias, domain, from_addr, subject, created_at, updated_at, status,
        message_id, error_code, error_message, recipient_count, r2_key
      ) VALUES ('send-1', 'sender', 'example.com', 'sender@example.com', 'subject',
        1, 1, 'accepted', 'cf-message-1', NULL, NULL, 6, 'sent/send-1.json')
    `).run();
    await testEnv.DB.batch(events.map(({ status }) => testEnv.DB.prepare(`
      INSERT INTO sent_recipients (sent_id, email, kind, status, updated_at, detail)
      VALUES ('send-1', ?, 'to', 'accepted', 1, NULL)
    `).bind(`${status}@example.net`)));

    const batch = createMessageBatch("mailsink-local-test-events", events.map((event, index) => ({
      id: `event-${event.status}`,
      timestamp: new Date(Date.parse(eventTime) + index),
      attempts: 1,
      body: {
        type: `cf.email.sending.message.${event.status}`,
        source: { type: "email.sending", zoneId: "zone-1", domain: "example.com" },
        payload: {
          eventId: `event-${event.status}`,
          messageId: "cf-message-1",
          sender: "sender@example.com",
          recipient: `${event.status}@example.net`,
          terminal: event.status !== "deferred",
          ...event.nested
        },
        metadata: {
          eventSchemaVersion: 1,
          eventTimestamp: eventTime
        }
      }
    })));
    await worker.queue(batch, testEnv);

    for (const { status, detail } of events) {
      expect(await testEnv.DB.prepare(`
        SELECT status, detail FROM sent_recipients
        WHERE sent_id = 'send-1' AND email = ?
      `).bind(`${status}@example.net`).first()).toMatchObject({ status, detail });
    }

    const duplicates = createMessageBatch("mailsink-local-test-events", [
      {
        id: "event-bounced-duplicate",
        timestamp: new Date(eventTime),
        attempts: 2,
        body: {
          type: "cf.email.sending.message.bounced",
          payload: {
            eventId: "event-bounced",
            messageId: "cf-message-1",
            recipient: "bounced@example.net",
            bounce: { reason: "duplicate must not replace the first event" }
          },
          metadata: { eventTimestamp: eventTime }
        }
      },
      {
        id: "event-older",
        timestamp: new Date("2026-05-31T02:48:57.132Z"),
        attempts: 1,
        body: {
          type: "cf.email.sending.message.delivered",
          payload: {
            eventId: "event-older",
            messageId: "cf-message-1",
            recipient: "bounced@example.net",
            delivery: { smtpResponse: "250 stale" }
          },
          metadata: { eventTimestamp: "2026-05-31T02:48:57.132Z" }
        }
      }
    ]);
    await worker.queue(duplicates, testEnv);

    expect(await testEnv.DB.prepare(`
      SELECT status, detail FROM sent_recipients
      WHERE sent_id = 'send-1' AND email = 'bounced@example.net'
    `).first()).toMatchObject({ status: "bounced", detail: "mailbox unavailable" });
  });
});
