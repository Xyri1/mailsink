import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fakes";

class FakeEmailMessage {
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  rejected: string | null = null;
  forwarded: string[] = [];
  onForward?: () => void | Promise<void>;

  constructor(public from: string, public to: string, body: string) {
    const bytes = new TextEncoder().encode(body);
    this.rawSize = bytes.byteLength;
    this.raw = new Response(bytes).body!;
  }

  setReject(reason: string) {
    this.rejected = reason;
  }

  async forward(destination: string) {
    await this.onForward?.();
    this.forwarded.push(destination);
  }
}

const plain = await readFile(new URL("./fixtures/plain.eml", import.meta.url), "utf8");

describe("email ingest", () => {
  test("stores before forwarding the configured base alias route", async () => {
    const env = makeEnv();
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2", domain: "example.com", status: "active", note: null,
      forward_to: "me@example.net", first_seen_at: 0, last_seen_at: 0, email_count: 0
    });
    const message = new FakeEmailMessage("bounce@em.netflix.com", "netflix-x7f2+login@example.com", plain);
    message.onForward = () => {
      expect(env.RAW.objects.size).toBe(1);
      expect(env.DB.emails.size).toBe(1);
    };

    await worker.email(message, env);

    expect(message.forwarded).toEqual(["me@example.net"]);
    expect([...env.DB.emails.values()][0]).toMatchObject({ forward_to: "me@example.net", forward_error: null });
  });

  test("records immediate forwarding failure without rejecting", async () => {
    const env = makeEnv();
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2", domain: "example.com", status: "active", note: null,
      forward_to: "me@example.net", first_seen_at: 0, last_seen_at: 0, email_count: 0
    });
    const message = new FakeEmailMessage("bounce@em.netflix.com", "netflix-x7f2@example.com", plain);
    message.onForward = () => { throw new Error("forward unavailable"); };

    await expect(worker.email(message, env)).resolves.toBeUndefined();
    expect(message.rejected).toBeNull();
    expect([...env.DB.emails.values()][0]?.forward_error).toBe("forward unavailable");
  });
  test("stores raw first, parses metadata, and upserts the implicit alias", async () => {
    const env = makeEnv();
    const message = new FakeEmailMessage("bounce@em.netflix.com", "Netflix-X7F2+login@Example.COM", plain);

    await worker.email(message, env);

    expect(message.rejected).toBeNull();
    expect([...env.RAW.objects.keys()]).toHaveLength(1);
    const row = [...env.DB.emails.values()][0];
    expect(row).toMatchObject({
      alias: "netflix-x7f2",
      domain: "example.com",
      to_addr: "Netflix-X7F2+login@Example.COM",
      envelope_from: "bounce@em.netflix.com",
      from_addr: "no-reply@em.netflix.com",
      from_name: "Netflix",
      subject: "Your sign-in code",
      has_html: 0,
      attachment_count: 0,
      parse_error: 0
    });
    expect(String(row?.text_body).trim()).toBe("Your code is 123456.");
    expect(env.DB.aliases.get(env.DB.aliasKey("netflix-x7f2", "example.com"))?.email_count).toBe(1);
  });

  test("rejects blocked aliases without storing raw or metadata", async () => {
    const env = makeEnv();
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2",
      domain: "example.com",
      status: "blocked",
      note: null,
      first_seen_at: 1781251200000,
      last_seen_at: 1781251200000,
      email_count: 0
    });
    const message = new FakeEmailMessage("spammer@example.net", "netflix-x7f2+spam@example.com", plain);

    await worker.email(message, env);

    expect(message.rejected).toBe("address unavailable");
    expect(env.RAW.objects.size).toBe(0);
    expect(env.DB.emails.size).toBe(0);
    expect(message.forwarded).toEqual([]);
  });

  test("drop mode silently ignores blocked aliases", async () => {
    const env = makeEnv({ BLOCK_MODE: "drop" });
    env.DB.aliases.set(env.DB.aliasKey("netflix-x7f2", "example.com"), {
      alias: "netflix-x7f2",
      domain: "example.com",
      status: "blocked",
      note: null,
      first_seen_at: 1781251200000,
      last_seen_at: 1781251200000,
      email_count: 0
    });
    const message = new FakeEmailMessage("spammer@example.net", "netflix-x7f2@example.com", plain);

    await worker.email(message, env);

    expect(message.rejected).toBeNull();
    expect(env.RAW.objects.size).toBe(0);
  });
});
